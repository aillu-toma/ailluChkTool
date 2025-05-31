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

// 残業申請チェック
function checkOvertime(dailyData, applicationData) {
    const errors = [];

    // 日次データから残業時間が8時間を超えるレコードを抽出
    const overtimeRecords = dailyData.filter(record => {
        const workType = record[4]; // 勤務区分
        const workHours = parseFloat(record[10]); // 実働時間
        return workType === 'EFS01' && workHours > 8;
    });

    // 各残業レコードに対して届け出データの確認
    overtimeRecords.forEach(record => {
        const employeeCode = record[0]; // 社員コード
        const date = record[2]; // 年月日

        // 届け出データから該当するレコードを検索
        const application = applicationData.find(app => 
            app[0] === employeeCode && // 社員コード
            app[4] === date && // 対象年月日
            app[2] === '80' // 届出区分
        );

        if (!application) {
            errors.push({
                type: '残業申請未提出',
                employeeCode: employeeCode,
                employeeName: record[1], // 社員氏名
                date: date,
                workHours: record[10]
            });
        }
    });

    return { errors };
}

// 在宅勤務チェック
function checkRemoteWork(dailyData, applicationData) {
    const errors = [];

    // 日次データから在宅勤務のレコードを抽出
    const remoteRecords = dailyData.filter(record => {
        const workType = record[4]; // 勤務区分
        return workType === 'EFS02'; // 在宅勤務の区分コード
    });

    // 各在宅勤務レコードに対して届け出データの確認
    remoteRecords.forEach(record => {
        const employeeCode = record[0];
        const date = record[2];

        // 届け出データから該当するレコードを検索
        const application = applicationData.find(app => 
            app[0] === employeeCode &&
            app[4] === date &&
            app[2] === '70' // 在宅勤務の届出区分
        );

        if (!application) {
            errors.push({
                type: '在宅勤務届出未提出',
                employeeCode: employeeCode,
                employeeName: record[1],
                date: date
            });
        }
    });

    return { errors };
}

// 在宅残業チェック
function checkRemoteOvertime(dailyData, applicationData) {
    const errors = [];

    // 日次データから在宅残業のレコードを抽出
    const remoteOvertimeRecords = dailyData.filter(record => {
        const workType = record[4]; // 勤務区分
        const workHours = parseFloat(record[10]); // 実働時間
        return workType === 'EFS02' && workHours > 8; // 在宅勤務で8時間超
    });

    // 各在宅残業レコードに対して届け出データの確認
    remoteOvertimeRecords.forEach(record => {
        const employeeCode = record[0];
        const date = record[2];

        // 届け出データから該当するレコードを検索
        const application = applicationData.find(app => 
            app[0] === employeeCode &&
            app[4] === date &&
            app[2] === '75' // 在宅残業の届出区分
        );

        if (!application) {
            errors.push({
                type: '在宅残業届出未提出',
                employeeCode: employeeCode,
                employeeName: record[1],
                date: date,
                workHours: record[10]
            });
        }
    });

    return { errors };
}

// 深夜勤務チェック
function checkLateNightWork(dailyData, applicationData) {
    const errors = [];

    // 日次データから深夜勤務のレコードを抽出
    const lateNightRecords = dailyData.filter(record => {
        const startTime = record[6]; // 就業開始時刻
        const endTime = record[7]; // 就業終了時刻
        return isLateNightWork(startTime, endTime);
    });

    // 各深夜勤務レコードに対して届け出データの確認
    lateNightRecords.forEach(record => {
        const employeeCode = record[0];
        const date = record[2];

        // 届け出データから該当するレコードを検索
        const application = applicationData.find(app => 
            app[0] === employeeCode &&
            app[4] === date &&
            app[2] === '85' // 深夜勤務の届出区分
        );

        if (!application) {
            errors.push({
                type: '深夜勤務届出未提出',
                employeeCode: employeeCode,
                employeeName: record[1],
                date: date,
                startTime: record[6],
                endTime: record[7]
            });
        }
    });

    return { errors };
}

// 深夜勤務判定
function isLateNightWork(startTime, endTime) {
    const start = new Date(`2000-01-01T${startTime}`);
    const end = new Date(`2000-01-01T${endTime}`);
    
    // 日付をまたぐ場合
    if (end < start) {
        end.setDate(end.getDate() + 1);
    }

    const lateNightStart = new Date(`2000-01-01T22:00:00`);
    const lateNightEnd = new Date(`2000-01-02T05:00:00`);

    return (start < lateNightEnd && end > lateNightStart);
}

// 打刻忘れコメントチェック
function checkMissingPunchComment(dailyData) {
    const errors = [];

    // 日次データから打刻忘れの可能性があるレコードを抽出
    const missingPunchRecords = dailyData.filter(record => {
        const startTime = record[6]; // 就業開始時刻
        const endTime = record[7]; // 就業終了時刻
        const comment = record[12]; // コメント
        return (!startTime || !endTime) && !comment;
    });

    // 各打刻忘れレコードに対してコメントの確認
    missingPunchRecords.forEach(record => {
        errors.push({
            type: '打刻忘れコメント未入力',
            employeeCode: record[0],
            employeeName: record[1],
            date: record[2],
            startTime: record[6],
            endTime: record[7]
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

        // ヘッダー行を除去
        dailyData.shift();
        applicationData.shift();

        let allErrors = [];

        // 残業申請チェック
        if (document.getElementById('overtimeCheck').checked) {
            const overtimeResults = checkOvertime(dailyData, applicationData);
            allErrors = allErrors.concat(overtimeResults.errors);
        }

        // 在宅勤務チェック
        if (document.getElementById('remoteCheck').checked) {
            const remoteResults = checkRemoteWork(dailyData, applicationData);
            allErrors = allErrors.concat(remoteResults.errors);
        }

        // 在宅残業チェック
        if (document.getElementById('remoteOvertimeCheck').checked) {
            const remoteOvertimeResults = checkRemoteOvertime(dailyData, applicationData);
            allErrors = allErrors.concat(remoteOvertimeResults.errors);
        }

        // 深夜勤務チェック
        if (document.getElementById('lateNightCheck').checked) {
            const lateNightResults = checkLateNightWork(dailyData, applicationData);
            allErrors = allErrors.concat(lateNightResults.errors);
        }

        // 打刻忘れコメントチェック
        if (document.getElementById('commentCheck').checked) {
            const commentResults = checkMissingPunchComment(dailyData);
            allErrors = allErrors.concat(commentResults.errors);
        }

        // 結果の表示
        if (allErrors.length === 0) {
            resultsContainer.innerHTML = '<div class="success-message">チェック結果：問題は見つかりませんでした。</div>';
        } else {
            // エラーを日付でソート
            allErrors.sort((a, b) => a.date.localeCompare(b.date));

            let errorHtml = '<div class="error-message">';
            errorHtml += '<h3>チェック結果：以下の問題が見つかりました</h3>';
            errorHtml += '<div class="error-list">';
            
            // エラーを日付ごとにグループ化
            const errorsByDate = {};
            allErrors.forEach(error => {
                if (!errorsByDate[error.date]) {
                    errorsByDate[error.date] = [];
                }
                errorsByDate[error.date].push(error);
            });

            // 日付ごとにエラーを表示
            Object.keys(errorsByDate).sort().forEach(date => {
                errorHtml += `<div class="error-date-group">`;
                errorHtml += `<h4 class="error-date">${date}</h4>`;
                errorHtml += '<ul class="error-items">';
                
                errorsByDate[date].forEach(error => {
                    errorHtml += '<li class="error-item">';
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
                    errorHtml += '</li>';
                });
                
                errorHtml += '</ul></div>';
            });

            errorHtml += '</div></div>';
            resultsContainer.innerHTML = errorHtml;
        }
    } catch (error) {
        resultsContainer.innerHTML = `<div class="error-message">エラーが発生しました: ${error.message}</div>`;
    }
}

// イベントリスナーの設定
document.getElementById('checkButton').addEventListener('click', performChecks); 