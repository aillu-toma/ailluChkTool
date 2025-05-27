// CSVファイルの読み込みと解析
async function readCSV(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const csvData = event.target.result;
            const rows = csvData.split('\n').map(row => row.split(','));
            resolve(rows);
        };
        reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
        reader.readAsText(file);
    });
}

// 残業申請チェック
function checkOvertime(dailyData, applicationData) {
    const results = [];
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
                date: date,
                workHours: record[10]
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

        // ヘッダー行を除去
        dailyData.shift();
        applicationData.shift();

        let allErrors = [];

        // 残業申請チェック
        if (document.getElementById('overtimeCheck').checked) {
            const overtimeResults = checkOvertime(dailyData, applicationData);
            allErrors = allErrors.concat(overtimeResults.errors);
        }

        // 結果の表示
        if (allErrors.length === 0) {
            resultsContainer.innerHTML = '<div class="success-message">チェック結果：問題は見つかりませんでした。</div>';
        } else {
            let errorHtml = '<div class="error-message">';
            errorHtml += '<h3>チェック結果：以下の問題が見つかりました</h3>';
            errorHtml += '<ul>';
            allErrors.forEach(error => {
                errorHtml += `<li>${error.type} - 社員コード: ${error.employeeCode}, 日付: ${error.date}, 実働時間: ${error.workHours}時間</li>`;
            });
            errorHtml += '</ul></div>';
            resultsContainer.innerHTML = errorHtml;
        }
    } catch (error) {
        resultsContainer.innerHTML = `<div class="error-message">エラーが発生しました: ${error.message}</div>`;
    }
}

// イベントリスナーの設定
document.getElementById('checkButton').addEventListener('click', performChecks); 