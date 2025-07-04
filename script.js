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
        comment: getColumnIndex(header, 'コメント'),
        approvalStatus: getColumnIndex(header, '承認状況') // 追加
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

// 60進数形式の時間（例: 0.3=30分, 0.15=15分）を分に変換する関数
function convert60TimeToMinutes(timeValue) {
    if (!timeValue || timeValue === '') return 0;
    const time = parseFloat(timeValue);
    if (isNaN(time)) return 0;
    const hours = Math.floor(time);
    const minutes = Math.round((time - hours) * 100);
    return hours * 60 + minutes;
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
            // 届出区分=80がない場合のみエラー。同日の他の申請（例: 81）は無視
            errors.push({
                type: '残業申請未提出',
                employeeCode: employeeCode,
                employeeName: record[dailyColumns.employeeName],
                date: date,
                workType: record[dailyColumns.workType],
                workHours: record[dailyColumns.workHours],
                detail: `実働時間: ${record[dailyColumns.workHours]}時間(8時間超過) 勤務区分: ${record[dailyColumns.workType]}`
            });
        }
    });
    return { errors };
}

// チェック1_1: 残業時間チェック（1分単位の誤差許容）
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
                // 期待残業時間も60進数で分換算
                const expectedOvertimeMinutes = convert60TimeToMinutes(overtimeHours);
                // 申請値は深夜外残業＋深夜残業の合計（60進数形式→分単位で合計）
                const lateNightOvertime = convert60TimeToMinutes(application[appColumns.lateNightOvertime]);
                const lateNightWork = convert60TimeToMinutes(application[appColumns.lateNightWork]);
                const actualOvertimeMinutes = lateNightOvertime + lateNightWork;
                const timeDifference = Math.abs(expectedOvertimeMinutes - actualOvertimeMinutes);
                if (timeDifference > 1) {
                    errors.push({
                        type: '残業時間不一致',
                        employeeCode: employeeCode,
                        employeeName: dailyRecord[dailyColumns.employeeName],
                        date: date,
                        workType: dailyRecord[dailyColumns.workType],
                        workHours: actualWorkHours,
                        expectedOvertime: expectedOvertimeMinutes,
                        actualOvertime: actualOvertimeMinutes,
                        detail: `期待残業時間: ${expectedOvertimeMinutes}分, 申請残業時間: ${actualOvertimeMinutes}分`
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

// チェック2_1: 在宅残業時間チェック（1分単位の誤差許容）
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
                // 期待在宅残業時間も60進数で分換算
                const expectedOvertimeMinutes = convert60TimeToMinutes(overtimeHours);
                // 申請値は深夜外残業＋深夜残業の合計（60進数形式→分単位で合計）
                const lateNightOvertime = convert60TimeToMinutes(application[appColumns.lateNightOvertime]);
                const lateNightWork = convert60TimeToMinutes(application[appColumns.lateNightWork]);
                const actualOvertimeMinutes = lateNightOvertime + lateNightWork;
                const timeDifference = Math.abs(expectedOvertimeMinutes - actualOvertimeMinutes);
                if (timeDifference > 1) {
                    errors.push({
                        type: '在宅残業時間不一致',
                        employeeCode: employeeCode,
                        employeeName: dailyRecord[dailyColumns.employeeName],
                        date: date,
                        workType: dailyRecord[dailyColumns.workType],
                        workHours: actualWorkHours,
                        expectedOvertime: expectedOvertimeMinutes,
                        actualOvertime: actualOvertimeMinutes,
                        detail: `期待在宅残業時間: ${expectedOvertimeMinutes}分, 申請在宅残業時間: ${actualOvertimeMinutes}分`
                    });
                }
            }
        }
    });
    return { errors };
}

// チェック3: 定時外の勤務（22時～5時の残業）
function checkLateNightWork(dailyData, applicationData, dailyColumns, appColumns, overtimeErrors) {
    const errors = [];
    // 1段階目: 実働時間>8 かつ 残業申請有無チェックでエラーになっていないデータ
    const validRecords = dailyData.filter(record => {
        const workHours = parseFloat(record[dailyColumns.workHours]) || 0;
        const employeeCode = record[dailyColumns.employeeCode];
        const date = record[dailyColumns.date];
        // 残業申請有無チェックでエラーになっていない
        const hasOvertimeError = overtimeErrors.some(e => e.employeeCode === employeeCode && e.date === date);
        return workHours > 8 && !hasOvertimeError;
    });
    validRecords.forEach(record => {
        const employeeCode = record[dailyColumns.employeeCode];
        const date = record[dailyColumns.date];
        const workHours = parseFloat(record[dailyColumns.workHours]) || 0;
        const workType = record[dailyColumns.workType];
        const endTime = record[dailyColumns.endTime];
        // 勤務区分ごとに対応する届け出区分を決定
        let targetAppType = null;
        if (workType === 'EFS01') {
            targetAppType = '80';
        } else if (workType === 'Z01') {
            targetAppType = '81';
        } else {
            return; // その他はスキップ
        }
        // トランザクション: 社員コード＋対象年月日＋届け出区分が一致する申請を取得
        const application = applicationData.find(app =>
            app[appColumns.employeeCode] === employeeCode &&
            app[appColumns.date] === date &&
            app[appColumns.applicationType] === targetAppType
        );
        if (!application) return;
        // ① 実働時間-8（60進数で分換算）
        const overtimeMinutes = convert60TimeToMinutes(workHours - 8);
        // ② 深夜外残業時間＋深夜残業時間（60進数形式→分単位で合計）
        const lateNightOvertime = convert60TimeToMinutes(application[appColumns.lateNightOvertime]);
        const lateNightWork = convert60TimeToMinutes(application[appColumns.lateNightWork]);
        const applicationOvertimeMinutes = lateNightOvertime + lateNightWork;
        if (Math.abs(overtimeMinutes - applicationOvertimeMinutes) > 1) {
            errors.push({
                type: '残業時間合計不一致',
                employeeCode: employeeCode,
                employeeName: record[dailyColumns.employeeName],
                date: date,
                workHours: workHours,
                expectedOvertime: overtimeMinutes,
                actualOvertime: applicationOvertimeMinutes,
                detail: `期待残業時間: ${overtimeMinutes}分, 申請残業時間合計: ${applicationOvertimeMinutes}分`
            });
        }
    });
    // 2段階目: 退勤時刻が22:00以降または翌朝5:00以前の場合の深夜残業時間チェック
    const lateNightRecords = validRecords.filter(record => {
        const endTime = record[dailyColumns.endTime];
        if (!endTime) return false;
        const [endHour, endMin] = endTime.split(':').map(Number);
        // 22:00 <= endTime < 29:00 (翌朝5:00)
        const endMinutes = endHour * 60 + endMin;
        // 22:00～翌5:00の間のみ
        return (endMinutes >= 22 * 60 && endMinutes < 29 * 60);
    });
    lateNightRecords.forEach(record => {
        const employeeCode = record[dailyColumns.employeeCode];
        const date = record[dailyColumns.date];
        const endTime = record[dailyColumns.endTime];
        // 22:00以降の分数を計算（1分単位）
        let lateNightMinutes = 0;
        if (endTime) {
            let [endHour, endMin] = endTime.split(':').map(Number);
            let endTotal = endHour * 60 + endMin;
            if (endTotal < 22 * 60) endTotal += 24 * 60; // 翌日5時まで対応
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
        if (!application) return;
        // 深夜残業時間（申請値、60進数形式→分単位）
        const lateNightWork = convert60TimeToMinutes(application[appColumns.lateNightWork]);
        const lateNightWorkMinutes = lateNightWork;
        if (Math.abs(lateNightMinutes - lateNightWorkMinutes) > 1) {
            errors.push({
                type: '深夜残業時間不一致',
                employeeCode: employeeCode,
                employeeName: record[dailyColumns.employeeName],
                date: date,
                endTime: endTime,
                expectedLateNight: lateNightMinutes / 60,
                actualLateNight: lateNightWorkMinutes / 60,
                detail: `期待深夜残業時間: ${(lateNightMinutes / 60).toFixed(2)}時間, 申請深夜残業時間: ${(lateNightWorkMinutes / 60).toFixed(2)}時間`
            });
        }
    });
    return { errors };
}

// チェック4: 打刻忘れ時コメント有無チェック（チェック0をパスしており、勤務区分が空白、承認状況が空白、または休暇コードが空白でない場合はスキップ、打刻開始または終了が0の場合のみコメント必須）
function checkMissingPunchComment(dailyData, dailyColumns, check0PassedEmployeeDates) {
    const errors = [];
    dailyData.forEach(record => {
        const workType = record[dailyColumns.workType];
        const approvalStatus = dailyColumns.approvalStatus !== undefined ? record[dailyColumns.approvalStatus] : undefined;
        const vacationCode = dailyColumns.vacationCode !== undefined ? record[dailyColumns.vacationCode] : undefined;
        if (!workType || workType.trim() === '' || (approvalStatus !== undefined && (!approvalStatus || approvalStatus.trim() === '')) || (vacationCode !== undefined && vacationCode.trim() !== '')) return; // 勤務区分空白、承認状況空白、または休暇コードが空白でない場合はスキップ
        const employeeCode = record[dailyColumns.employeeCode];
        const date = record[dailyColumns.date];
        // チェック0をパスしたデータのみ対象
        if (!check0PassedEmployeeDates.has(`${employeeCode}_${date}`)) return;
        const startTime = record[dailyColumns.startTime];
        const endTime = record[dailyColumns.endTime];
        const comment = record[dailyColumns.comment];
        const isStartZero = (startTime && startTime.trim() === '0');
        const isEndZero = (endTime && endTime.trim() === '0');
        if ((isStartZero || isEndZero) && (!comment || comment.trim() === '')) {
            errors.push({
                type: '打刻忘れコメント未入力',
                employeeCode: employeeCode,
                employeeName: record[dailyColumns.employeeName],
                date: date,
                startTime: startTime,
                endTime: endTime,
                detail: '打刻時間が0ですが、コメントが入力されていません'
            });
        }
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
        let overtimeErrors = [];
        let check0PassedEmployeeDates = new Set();
        // チェック0: 在宅か出社かチェック
        if (document.getElementById('workTypeCheck').checked) {
            const workTypeResults = checkWorkType(dailyData, applicationData, dailyColumns, appColumns);
            allErrors = allErrors.concat(workTypeResults.errors);
            // チェック0をパスしたデータ（エラーでないもの）をセットに格納
            dailyData.forEach(record => {
                const workType = record[dailyColumns.workType];
                if (!workType || workType.trim() === '') return;
                const employeeCode = record[dailyColumns.employeeCode];
                const date = record[dailyColumns.date];
                // EFS01またはZ01で、エラーでない場合
                if ((workType === 'EFS01' || workType === 'Z01') && !workTypeResults.errors.some(e => e.employeeCode === employeeCode && e.date === date)) {
                    check0PassedEmployeeDates.add(`${employeeCode}_${date}`);
                }
            });
        } else {
            // チェック0を実施しない場合は全データを対象
            dailyData.forEach(record => {
                const employeeCode = record[dailyColumns.employeeCode];
                const date = record[dailyColumns.date];
                check0PassedEmployeeDates.add(`${employeeCode}_${date}`);
            });
        }
        // チェック1: 残業申請有無チェック
        if (document.getElementById('overtimeCheck').checked) {
            const overtimeResults = checkOvertimeApplication(dailyData, applicationData, dailyColumns, appColumns);
            allErrors = allErrors.concat(overtimeResults.errors);
            overtimeErrors = overtimeResults.errors;
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
            const lateNightResults = checkLateNightWork(dailyData, applicationData, dailyColumns, appColumns, overtimeErrors);
            allErrors = allErrors.concat(lateNightResults.errors);
        }

        // チェック4: 打刻忘れコメントチェック
        if (document.getElementById('commentCheck').checked) {
            const commentResults = checkMissingPunchComment(dailyData, dailyColumns, check0PassedEmployeeDates);
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
            if (error.workType) {
                errorHtml += `<span class="error-worktype">勤務区分: ${error.workType}</span>`;
            }
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