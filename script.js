// CSVファイルの読み込みと解析
async function readCSV(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                // ArrayBufferとして読み込む
                const arrayBuffer = event.target.result;
                
                // TextDecoderを使用してSJISからUTF-8に変換
                const decoder = new TextDecoder('shift-jis');
                const text = decoder.decode(arrayBuffer);
                
                // 改行コードを統一
                const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                
                // CSVとして解析
                const rows = normalizedText.split('\n').map(row => {
                    // カンマで分割し、ダブルクォートで囲まれた値も正しく処理
                    const values = [];
                    let currentValue = '';
                    let inQuotes = false;
                    
                    for (let i = 0; i < row.length; i++) {
                        const char = row[i];
                        
                        if (char === '"') {
                            inQuotes = !inQuotes;
                        } else if (char === ',' && !inQuotes) {
                            values.push(currentValue);
                            currentValue = '';
                        } else {
                            currentValue += char;
                        }
                    }
                    values.push(currentValue);
                    
                    return values;
                });
                
                resolve(rows);
            } catch (error) {
                reject(new Error('ファイルの読み込みに失敗しました: ' + error.message));
            }
        };
        reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
        // ArrayBufferとして読み込む
        reader.readAsArrayBuffer(file);
    });
}

// CSVの項目名は必ず文字列一致で判定し、配列位置で判定しない
function getColumnIndex(header, columnName) {
    return header.findIndex(h => h.trim() === columnName.trim());
}

// 日次データの項目位置を取得
function getDailyDataColumns(header) {
    return {
        employeeCode: getColumnIndex(header, '社員コード'),
        employeeName: getColumnIndex(header, '社員氏名（漢字）'),
        date: getColumnIndex(header, '年月日'),
        weekdayCode: getColumnIndex(header, '曜日コード'),
        workType: getColumnIndex(header, '勤務区分'),
        workTypeName: getColumnIndex(header, '勤務区分名称（漢字）'),
        startTime: getColumnIndex(header, '就業開始時刻'),
        endTime: getColumnIndex(header, '就業終了時刻'),
        vacationCode: getColumnIndex(header, '休暇コード'),
        vacationName: getColumnIndex(header, '休暇コード名称'),
        workHours: getColumnIndex(header, '実働時間'),
        flexTime: getColumnIndex(header, 'フレックス対象時間差'),
        comment: getColumnIndex(header, 'コメント')
    };
}

// 届け出データの項目位置を取得
function getApplicationDataColumns(header) {
    return {
        employeeCode: getColumnIndex(header, '社員コード'),
        employeeName: getColumnIndex(header, '社員氏名（漢字）'),
        applicationType: getColumnIndex(header, '届出区分'),
        applicationName: getColumnIndex(header, '届出略称'),
        date: getColumnIndex(header, '対象年月日'),
        vacationName: getColumnIndex(header, '休暇名称（漢字）'),
        lateNightOvertime: getColumnIndex(header, '深夜外残業時間'),
        lateNightWork: getColumnIndex(header, '深夜残業時間')
    };
}

// 時間を分に変換（小数点形式から）
function convertTimeToMinutes(timeValue) {
    if (!timeValue || timeValue === '') return 0;
    
    const time = parseFloat(timeValue);
    if (isNaN(time)) return 0;
    
    // 小数点以下は10分単位（0.1 = 6分）
    const hours = Math.floor(time);
    const minutes = Math.round((time - hours) * 60);
    
    return hours * 60 + minutes;
}

// 分を時間の小数点形式に変換
function convertMinutesToTime(minutes) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return hours + (remainingMinutes / 60);
}

// チェック0: 在宅か出社かチェック
function checkWorkType(dailyData, applicationData, dailyColumns, appColumns) {
    const errors = [];
    const check1Targets = []; // チェック1の対象
    const check2Targets = []; // チェック2の対象

    dailyData.forEach(record => {
        const workType = record[dailyColumns.workType];
        const employeeCode = record[dailyColumns.employeeCode];
        const date = record[dailyColumns.date];
        const employeeName = record[dailyColumns.employeeName];

        // 勤務区分が空白の場合はスキップ
        if (!workType || workType.trim() === '') {
            return;
        }

        if (workType === 'EFS01') {
            // 出社の場合、チェック1の対象とする
            check1Targets.push(record);
        } else if (workType === 'Z01') {
            // 在宅の場合、届出区分=85の確認
            const application = applicationData.find(app => 
                app[appColumns.employeeCode] === employeeCode &&
                app[appColumns.date] === date &&
                app[appColumns.applicationType] === '85'
            );

            if (application) {
                // 届出区分=85がある場合、チェック2の対象とする
                check2Targets.push(record);
            } else {
                errors.push({
                    type: '在宅勤務届出未提出',
                    employeeCode: employeeCode,
                    employeeName: employeeName,
                    date: date,
                    detail: '在宅勤務（Z01）ですが、届出区分=85の届出が提出されていません'
                });
            }
        } else {
            // 上記以外はエラー
            errors.push({
                type: '不正な勤務区分',
                employeeCode: employeeCode,
                employeeName: employeeName,
                date: date,
                workType: workType,
                detail: `不正な勤務区分: ${workType}（EFS01またはZ01である必要があります）`
            });
        }
    });

    return { errors, check1Targets, check2Targets };
}

// チェック1: 残業申請有無チェック
function checkOvertimeApplication(dailyData, applicationData, dailyColumns, appColumns) {
    const errors = [];
    // マスタ: 勤務区分=EFS01 かつ 実働時間>8 の日付を取得
    const overtimeRecords = dailyData.filter(record => {
        const workType = record[dailyColumns.workType];
        const workHours = parseFloat(record[dailyColumns.workHours]) || 0;
        // 勤務区分がZで始まる場合はスキップ
        if (workType && workType.startsWith('Z')) {
            return false;
        }
        return workType === 'EFS01' && workHours > 8;
    });
    overtimeRecords.forEach(record => {
        const employeeCode = record[dailyColumns.employeeCode];
        const date = record[dailyColumns.date];
        // トランザクション: 社員コード＋対象年月日が一致し、届出区分=80が存在するか
        const application = applicationData.find(app =>
            app[appColumns.employeeCode] === employeeCode &&
            app[appColumns.date] === date &&
            app[appColumns.applicationType] === '80'
        );
        if (!application) {
            errors.push({
                type: '残業申請未提出',
                employeeCode: employeeCode,
                employeeName: record[dailyColumns.employeeName],
                date: date,
                workHours: record[dailyColumns.workHours],
                detail: `実働時間: ${record[dailyColumns.workHours]}時間(8時間超過)`
            });
        }
    });
    return { errors };
}

// チェック1_1: 残業時間チェック（10分単位の誤差許容）
function checkOvertimeHours(dailyData, applicationData, dailyColumns, appColumns) {
    const errors = [];
    // 残業申請（届出区分=80）があるもの
    const overtimeApplications = applicationData.filter(app => app[appColumns.applicationType] === '80');
    overtimeApplications.forEach(application => {
        const employeeCode = application[appColumns.employeeCode];
        const date = application[appColumns.date];
        // マスタと照合
        const dailyRecord = dailyData.find(daily =>
            daily[dailyColumns.employeeCode] === employeeCode &&
            daily[dailyColumns.date] === date
        );
        if (dailyRecord) {
            const actualWorkHours = parseFloat(dailyRecord[dailyColumns.workHours]) || 0;
            const overtimeHours = actualWorkHours - 8;
            if (overtimeHours > 0) {
                // 10分単位の誤差許容
                const expectedOvertimeMinutes = Math.round(overtimeHours * 60 / 10) * 10;
                // 申請値は深夜外残業＋深夜残業の合計
                const lateNightOvertime = parseFloat(application[appColumns.lateNightOvertime]) || 0;
                const lateNightWork = parseFloat(application[appColumns.lateNightWork]) || 0;
                const actualOvertimeMinutes = Math.round((lateNightOvertime + lateNightWork) * 60 / 10) * 10;
                const timeDifference = Math.abs(expectedOvertimeMinutes - actualOvertimeMinutes);
                if (timeDifference > 10) {
                    errors.push({
                        type: '残業時間不一致',
                        employeeCode: employeeCode,
                        employeeName: dailyRecord[dailyColumns.employeeName],
                        date: date,
                        workHours: actualWorkHours,
                        expectedOvertime: expectedOvertimeMinutes / 60,
                        actualOvertime: actualOvertimeMinutes / 60,
                        detail: `期待残業時間: ${expectedOvertimeMinutes / 60}時間, 申請残業時間: ${actualOvertimeMinutes / 60}時間`
                    });
                }
            }
        }
    });
    return { errors };
}

// チェック2: 在宅残業申請チェック
function checkRemoteOvertimeApplication(dailyData, applicationData, dailyColumns, appColumns) {
    const errors = [];
    // マスタ: 勤務区分=Z01 かつ 実働時間>8 の日付を取得
    const remoteOvertimeRecords = dailyData.filter(record => {
        const workType = record[dailyColumns.workType];
        const workHours = parseFloat(record[dailyColumns.workHours]) || 0;
        return workType === 'Z01' && workHours > 8;
    });
    remoteOvertimeRecords.forEach(record => {
        const employeeCode = record[dailyColumns.employeeCode];
        const date = record[dailyColumns.date];
        // トランザクション: 社員コード＋対象年月日が一致し、届出区分=81が存在するか
        const application = applicationData.find(app =>
            app[appColumns.employeeCode] === employeeCode &&
            app[appColumns.date] === date &&
            app[appColumns.applicationType] === '81'
        );
        if (!application) {
            errors.push({
                type: '在宅残業申請未提出',
                employeeCode: employeeCode,
                employeeName: record[dailyColumns.employeeName],
                date: date,
                workHours: record[dailyColumns.workHours],
                detail: `在宅勤務で実働時間: ${record[dailyColumns.workHours]}時間(8時間超過)`
            });
        }
    });
    return { errors };
}

// チェック2_1: 在宅残業時間チェック（10分単位の誤差許容）
function checkRemoteOvertimeHours(dailyData, applicationData, dailyColumns, appColumns) {
    const errors = [];
    // 在宅残業申請（届出区分=81）があるもの
    const remoteOvertimeApplications = applicationData.filter(app => app[appColumns.applicationType] === '81');
    remoteOvertimeApplications.forEach(application => {
        const employeeCode = application[appColumns.employeeCode];
        const date = application[appColumns.date];
        // マスタと照合
        const dailyRecord = dailyData.find(daily =>
            daily[dailyColumns.employeeCode] === employeeCode &&
            daily[dailyColumns.date] === date
        );
        if (dailyRecord) {
            const actualWorkHours = parseFloat(dailyRecord[dailyColumns.workHours]) || 0;
            const overtimeHours = actualWorkHours - 8;
            if (overtimeHours > 0) {
                // 10分単位の誤差許容
                const expectedOvertimeMinutes = Math.round(overtimeHours * 60 / 10) * 10;
                // 申請値は深夜外残業＋深夜残業の合計
                const lateNightOvertime = parseFloat(application[appColumns.lateNightOvertime]) || 0;
                const lateNightWork = parseFloat(application[appColumns.lateNightWork]) || 0;
                const actualOvertimeMinutes = Math.round((lateNightOvertime + lateNightWork) * 60 / 10) * 10;
                const timeDifference = Math.abs(expectedOvertimeMinutes - actualOvertimeMinutes);
                if (timeDifference > 10) {
                    errors.push({
                        type: '在宅残業時間不一致',
                        employeeCode: employeeCode,
                        employeeName: dailyRecord[dailyColumns.employeeName],
                        date: date,
                        workHours: actualWorkHours,
                        expectedOvertime: expectedOvertimeMinutes / 60,
                        actualOvertime: actualOvertimeMinutes / 60,
                        detail: `期待在宅残業時間: ${expectedOvertimeMinutes / 60}時間, 申請在宅残業時間: ${actualOvertimeMinutes / 60}時間`
                    });
                }
            }
        }
    });
    return { errors };
}

// チェック3: 定時外の勤務（22時～5時の残業）
function checkLateNightWork(dailyData, applicationData, dailyColumns, appColumns) {
    const errors = [];
    // 退勤時刻が22時以降または5時以前の勤務を抽出
    const lateNightRecords = dailyData.filter(record => {
        const endTime = record[dailyColumns.endTime];
        if (!endTime) return false;
        const [endHour, endMin] = endTime.split(':').map(Number);
        return (endHour > 22 || (endHour === 22 && endMin > 0) || endHour < 5);
    });
    lateNightRecords.forEach(record => {
        const employeeCode = record[dailyColumns.employeeCode];
        const date = record[dailyColumns.date];
        const endTime = record[dailyColumns.endTime];
        // 22:00以降の分数を計算
        let lateNightMinutes = 0;
        if (endTime) {
            let [endHour, endMin] = endTime.split(':').map(Number);
            if (endHour < 5) endHour += 24; // 翌日5時まで対応
            const endTotal = endHour * 60 + endMin;
            const base = 22 * 60; // 22:00 in minutes
            if (endTotal > base) {
                lateNightMinutes = endTotal - base;
            }
        }
        // トランザクション: 社員コード＋対象年月日が一致する申請を取得
        const application = applicationData.find(app =>
            app[appColumns.employeeCode] === employeeCode &&
            app[appColumns.date] === date
        );
        if (!application) {
            errors.push({
                type: '深夜勤務申請未提出',
                employeeCode: employeeCode,
                employeeName: record[dailyColumns.employeeName],
                date: date,
                endTime: endTime,
                detail: `深夜勤務時間: ${endTime}`
            });
        } else {
            // 深夜残業時間（申請値）
            const lateNightWork = parseFloat(application[appColumns.lateNightWork]) || 0;
            const lateNightWorkMinutes = Math.round(lateNightWork * 60);
            if (Math.abs(lateNightMinutes - lateNightWorkMinutes) > 10) { // 10分単位誤差許容
                errors.push({
                    type: '深夜残業時間不一致',
                    employeeCode: employeeCode,
                    employeeName: record[dailyColumns.employeeName],
                    date: date,
                    endTime: endTime,
                    expectedLateNight: lateNightMinutes / 60,
                    actualLateNight: lateNightWork,
                    detail: `期待深夜残業時間: ${(lateNightMinutes / 60).toFixed(2)}時間, 申請深夜残業時間: ${lateNightWork}時間`
                });
            }
        }
    });
    return { errors };
}

// チェック4: 打刻忘れ時コメント有無チェック（打刻忘れ時のみコメント必須）
function checkMissingPunchComment(dailyData, dailyColumns) {
    const errors = [];
    // 開始時刻または終了時刻が空、かつコメントも空の場合のみ
    const missingPunchRecords = dailyData.filter(record => {
        const startTime = record[dailyColumns.startTime];
        const endTime = record[dailyColumns.endTime];
        const comment = record[dailyColumns.comment];
        return (!startTime || startTime.trim() === '' || !endTime || endTime.trim() === '') && (!comment || comment.trim() === '');
    });
    missingPunchRecords.forEach(record => {
        errors.push({
            type: '打刻忘れコメント未入力',
            employeeCode: record[dailyColumns.employeeCode],
            employeeName: record[dailyColumns.employeeName],
            date: record[dailyColumns.date],
            startTime: record[dailyColumns.startTime],
            endTime: record[dailyColumns.endTime],
            detail: '打刻忘れの可能性がありますが、コメントが入力されていません'
        });
    });
    return { errors };
}

// メインのチェック処理
async function performChecks() {
    const dailyDataFile = document.getElementById('dailyData').files[0];
    const applicationDataFile = document.getElementById('applicationData').files[0];
    const resultsContainer = document.getElementById('results');

    if (!dailyDataFile || !applicationDataFile) {
        resultsContainer.innerHTML = '<div class="error-message">両方のCSVファイルをアップロードしてください。</div>';
        return;
    }

    try {
        // CSVファイルの読み込み
        const dailyData = await readCSV(dailyDataFile);
        const applicationData = await readCSV(applicationDataFile);

        // ヘッダー行を取得
        const dailyHeader = dailyData.shift();
        const appHeader = applicationData.shift();

        // 項目位置を取得
        const dailyColumns = getDailyDataColumns(dailyHeader);
        const appColumns = getApplicationDataColumns(appHeader);

        let allErrors = [];

        // チェック0: 在宅か出社かチェック
        if (document.getElementById('workTypeCheck').checked) {
            const workTypeResults = checkWorkType(dailyData, applicationData, dailyColumns, appColumns);
            allErrors = allErrors.concat(workTypeResults.errors);
        }

        // チェック1: 残業申請有無チェック
        if (document.getElementById('overtimeCheck').checked) {
            const overtimeResults = checkOvertimeApplication(dailyData, applicationData, dailyColumns, appColumns);
            allErrors = allErrors.concat(overtimeResults.errors);
        }

        // チェック1_1: 残業時間チェック
        if (document.getElementById('overtimeHoursCheck').checked) {
            const overtimeHoursResults = checkOvertimeHours(dailyData, applicationData, dailyColumns, appColumns);
            allErrors = allErrors.concat(overtimeHoursResults.errors);
        }

        // チェック2: 在宅残業申請チェック
        if (document.getElementById('remoteOvertimeCheck').checked) {
            const remoteOvertimeResults = checkRemoteOvertimeApplication(dailyData, applicationData, dailyColumns, appColumns);
            allErrors = allErrors.concat(remoteOvertimeResults.errors);
        }

        // チェック2_1: 在宅残業時間チェック
        if (document.getElementById('remoteOvertimeHoursCheck').checked) {
            const remoteOvertimeHoursResults = checkRemoteOvertimeHours(dailyData, applicationData, dailyColumns, appColumns);
            allErrors = allErrors.concat(remoteOvertimeHoursResults.errors);
        }

        // チェック3: 定時外の勤務
        if (document.getElementById('lateNightCheck').checked) {
            const lateNightResults = checkLateNightWork(dailyData, applicationData, dailyColumns, appColumns);
            allErrors = allErrors.concat(lateNightResults.errors);
        }

        // チェック4: 打刻忘れコメントチェック
        if (document.getElementById('commentCheck').checked) {
            const commentResults = checkMissingPunchComment(dailyData, dailyColumns);
            allErrors = allErrors.concat(commentResults.errors);
        }

        // 結果の表示
        displayResults(allErrors, resultsContainer);
    } catch (error) {
        resultsContainer.innerHTML = `<div class="error-message">エラーが発生しました: ${error.message}</div>`;
    }
}

// 結果表示関数
function displayResults(errors, container) {
    if (errors.length === 0) {
        container.innerHTML = '<div class="success-message">チェック結果：問題は見つかりませんでした。</div>';
        return;
    }

    let resultHtml = '<div class="results-summary">';
    resultHtml += `<h3>チェック結果</h3>`;
    resultHtml += `<p>エラー: ${errors.length}件</p>`;
    resultHtml += '</div>';

    // エラーの表示
    if (errors.length > 0) {
        resultHtml += '<div class="error-section">';
        resultHtml += '<h4 class="section-title error-title">エラー</h4>';
        resultHtml += displayErrorList(errors);
        resultHtml += '</div>';
    }

    container.innerHTML = resultHtml;
}

// エラーリスト表示関数
function displayErrorList(errors, type = 'error') {
    if (errors.length === 0) return '';

    // エラーを日付でソート
    errors.sort((a, b) => a.date.localeCompare(b.date));

    let errorHtml = '<div class="error-list">';
    
    // エラーを日付ごとにグループ化
    const errorsByDate = {};
    errors.forEach(error => {
        if (!errorsByDate[error.date]) {
            errorsByDate[error.date] = [];
        }
        errorsByDate[error.date].push(error);
    });

    // 日付ごとにエラーを表示
    Object.keys(errorsByDate).sort().forEach(date => {
        errorHtml += `<div class="error-date-group ${type}-date-group">`;
        errorHtml += `<h5 class="error-date">${date}</h5>`;
        errorHtml += '<ul class="error-items">';
        
        errorsByDate[date].forEach(error => {
            errorHtml += `<li class="error-item ${type}-item">`;
            errorHtml += `<span class="error-type">${error.type}</span>`;
            errorHtml += `<span class="error-name">${error.employeeName}</span>`;
            if (error.workHours) {
                errorHtml += `<span class="error-hours">実働時間: ${error.workHours}時間</span>`;
            }
            if (error.startTime || error.endTime) {
                errorHtml += `<span class="error-time">`;
                if (error.startTime) errorHtml += `開始: ${error.startTime}`;
                if (error.endTime) errorHtml += ` 終了: ${error.endTime}`;
                errorHtml += `</span>`;
            }
            if (error.detail) {
                errorHtml += `<span class="error-detail">${error.detail}</span>`;
            }
            errorHtml += '</li>';
        });
        
        errorHtml += '</ul></div>';
    });

    errorHtml += '</div>';
    return errorHtml;
}

// イベントリスナーの設定
document.getElementById('checkButton').addEventListener('click', performChecks); 