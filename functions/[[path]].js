// Lark Base 自動構築ツール - 完全改善版
// 元のエラーを完全に解決し、ユーザビリティを大幅に向上させたバージョン

// Lark APIのベースURL
const LARK_API_URL = 'https://open.larksuite.com/open-apis';

/**
 * Cloudflare Pages Function
 * すべてのリクエストを処理します。
 * - GETリクエストにはHTML UIを返します。
 * - POST /api/create にはAPIロジックを実行します。
 */
export async function onRequest({ request, env }) {
    const url = new URL(request.url);

    // APIへのPOSTリクエストを処理
    if (request.method === 'POST' && url.pathname === '/api/create') {
        return handleApiPost({ request, env });
    }

    // それ以外のすべてのリクエスト（例: GET /）にはUIを表示
    return serveHtml();
}

/**
 * APIのロジックを処理する関数（完全改善版）
 */
async function handleApiPost({ request, env }) {
    try {
        const { prompt } = await request.json();
        if (!prompt || prompt.trim().length === 0) {
            throw new Error('指示内容を入力してください。');
        }

        // 入力内容の検証
        if (prompt.length > 2000) {
            throw new Error('指示内容が長すぎます。2000文字以内で入力してください。');
        }

        // --- Step 1: AIにBase名とテーブル構成を設計させる ---
        const aiResponse = await generateSchemaFromAI(prompt, env.GEMINI_API_KEY);
        const { baseName, tables } = aiResponse;

        if (!baseName || !tables || tables.length === 0) {
            throw new Error('AIによるBase構成の生成に失敗しました。指示内容をより具体的にしてください。');
        }

        // テーブル数の制限
        if (tables.length > 10) {
            throw new Error('テーブル数が多すぎます。10個以下になるよう指示内容を調整してください。');
        }
        
        const tenantAccessToken = await getTenantAccessToken(env);

        // --- Step 2: AIの設計に基づいて新しいBaseを作成 ---
        const createBaseRes = await createBaseApp(tenantAccessToken, baseName);
        const newAppToken = createBaseRes.data.app.app_token;
        const newBaseUrl = createBaseRes.data.app.url;

        const results = [];
        
        // --- Step 3: 作成されたBase内にテーブルとフィールドを構築 ---
        for (let i = 0; i < tables.length; i++) {
            const table = tables[i];
            try {
                // テーブル作成
                const createTableRes = await apiCall(tenantAccessToken, `/base/v1/apps/${newAppToken}/tables`, { 
                    method: 'POST', 
                    body: { name: table.name } 
                });
                const tableId = createTableRes.data.table_id;
                
                await sleep(500); // Rate limit対策

                // フィールド作成
                let fieldsCreated = 0;
                for (const field of table.fields) {
                    try {
                        const fieldPayload = getFieldProperty(field.type, field.options || {});
                        if (!fieldPayload) {
                            console.warn(`Unsupported field type: ${field.type}`);
                            continue;
                        }
                        
                        await apiCall(tenantAccessToken, `/base/v1/apps/${newAppToken}/tables/${tableId}/fields`, {
                            method: 'POST',
                            body: { 
                                field_name: field.name, 
                                type: fieldPayload.type, 
                                property: fieldPayload.property 
                            }
                        });
                        fieldsCreated++;
                        await sleep(300); // Rate limit対策
                    } catch (fieldError) {
                        console.warn(`Field creation failed for ${field.name}:`, fieldError.message);
                    }
                }
                
                // サンプルデータ追加
                let recordsAdded = 0;
                if (table.sampleDataCount > 0 && fieldsCreated > 0) {
                    try {
                        const addRecordsRes = await addSampleRecords(
                            tenantAccessToken, 
                            newAppToken, 
                            tableId, 
                            table.fields, 
                            Math.min(table.sampleDataCount, 20) // 最大20件に制限
                        );
                        recordsAdded = addRecordsRes.data?.records?.length || 0;
                    } catch (recordError) {
                        console.warn(`Sample data creation failed for table ${table.name}:`, recordError.message);
                    }
                }
                
                results.push({ 
                    tableName: table.name, 
                    status: 'Success', 
                    tableId, 
                    fieldsCreated,
                    recordsAdded 
                });
                
            } catch (tableError) {
                console.error(`Table creation failed for ${table.name}:`, tableError);
                results.push({ 
                    tableName: table.name, 
                    status: 'Failed', 
                    error: tableError.message 
                });
            }
        }

        return new Response(JSON.stringify({
            success: true,
            message: 'Baseの作成が完了しました！',
            baseName: baseName,
            baseUrl: newBaseUrl,
            summary: {
                totalTables: tables.length,
                successfulTables: results.filter(r => r.status === 'Success').length,
                failedTables: results.filter(r => r.status === 'Failed').length
            },
            details: results
        }, null, 2), { 
            headers: { 'Content-Type': 'application/json' } 
        });

    } catch (error) {
        console.error("Error details:", error);
        
        // ユーザーフレンドリーなエラーメッセージを生成
        let userMessage = error.message;
        if (error.message.includes('GEMINI_API_KEY')) {
            userMessage = 'AI機能の設定に問題があります。管理者にお問い合わせください。';
        } else if (error.message.includes('tenant_access_token')) {
            userMessage = 'Lark APIの認証に失敗しました。設定を確認してください。';
        } else if (error.message.includes('rate limit') || error.message.includes('429')) {
            userMessage = 'APIの利用制限に達しました。しばらく待ってから再試行してください。';
        }
        
        return new Response(JSON.stringify({ 
            success: false,
            error: userMessage,
            timestamp: new Date().toISOString()
        }, null, 2), { 
            status: 500, 
            headers: { 'Content-Type': 'application/json' } 
        });
    }
}

/**
 * フロントエンドのHTML UIを生成する関数（完全改善版）
 */
function serveHtml() {
    const html = `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Lark Base 自動構築ツール (AI対応版)</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
        <style>
            :root {
                --primary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                --secondary-gradient: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
                --success-gradient: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
                --error-gradient: linear-gradient(135deg, #fa709a 0%, #fee140 100%);
                --warning-gradient: linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%);
                --glass-bg: rgba(255, 255, 255, 0.25);
                --glass-border: rgba(255, 255, 255, 0.18);
                --text-primary: #2d3748;
                --text-secondary: #4a5568;
                --text-muted: #718096;
                --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.24);
                --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.07), 0 2px 4px rgba(0, 0, 0, 0.06);
                --shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.1), 0 4px 6px rgba(0, 0, 0, 0.05);
                --shadow-xl: 0 20px 25px rgba(0, 0, 0, 0.1), 0 10px 10px rgba(0, 0, 0, 0.04);
            }

            * { 
                box-sizing: border-box; 
                margin: 0; 
                padding: 0; 
            }

            body { 
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; 
                line-height: 1.6; 
                background: var(--primary-gradient);
                min-height: 100vh;
                color: var(--text-primary);
                overflow-x: hidden;
            }

            .background-animation {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                z-index: -1;
                background: var(--primary-gradient);
            }

            .background-animation::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><pattern id="grain" width="100" height="100" patternUnits="userSpaceOnUse"><circle cx="25" cy="25" r="1" fill="rgba(255,255,255,0.1)"/><circle cx="75" cy="75" r="1" fill="rgba(255,255,255,0.1)"/><circle cx="50" cy="10" r="0.5" fill="rgba(255,255,255,0.05)"/><circle cx="10" cy="60" r="0.5" fill="rgba(255,255,255,0.05)"/><circle cx="90" cy="40" r="0.5" fill="rgba(255,255,255,0.05)"/></pattern></defs><rect width="100" height="100" fill="url(%23grain)"/></svg>');
                animation: float 20s ease-in-out infinite;
            }

            @keyframes float {
                0%, 100% { transform: translateY(0px) rotate(0deg); }
                50% { transform: translateY(-20px) rotate(1deg); }
            }

            .container { 
                max-width: 1000px;
                margin: 0 auto;
                padding: 2rem;
                position: relative;
                z-index: 1;
            }

            .main-card {
                background: var(--glass-bg);
                backdrop-filter: blur(20px);
                border: 1px solid var(--glass-border);
                border-radius: 24px;
                padding: 3rem;
                box-shadow: var(--shadow-xl);
                position: relative;
                overflow: hidden;
            }

            .main-card::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                height: 1px;
                background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent);
            }

            .header {
                text-align: center;
                margin-bottom: 3rem;
            }

            .header h1 { 
                font-size: 3rem; 
                font-weight: 700;
                background: linear-gradient(135deg, #667eea, #764ba2);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
                margin-bottom: 0.5rem;
                letter-spacing: -0.02em;
            }

            .header .subtitle {
                font-size: 1.25rem;
                color: var(--text-secondary);
                font-weight: 400;
                opacity: 0.8;
            }

            .feature-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                gap: 1.5rem;
                margin-bottom: 3rem;
            }

            .feature-card {
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 16px;
                padding: 1.5rem;
                text-align: center;
                transition: all 0.3s ease;
                backdrop-filter: blur(10px);
            }

            .feature-card:hover {
                transform: translateY(-5px);
                box-shadow: var(--shadow-lg);
                background: rgba(255, 255, 255, 0.15);
            }

            .feature-icon {
                font-size: 2.5rem;
                margin-bottom: 1rem;
                display: block;
            }

            .feature-title {
                font-size: 1.1rem;
                font-weight: 600;
                color: white;
                margin-bottom: 0.5rem;
            }

            .feature-desc {
                font-size: 0.9rem;
                color: rgba(255, 255, 255, 0.8);
                line-height: 1.5;
            }

            .info-section {
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 16px;
                padding: 2rem;
                margin-bottom: 2rem;
                backdrop-filter: blur(10px);
            }

            .info-section h3 {
                color: white;
                font-size: 1.3rem;
                font-weight: 600;
                margin-bottom: 1rem;
                display: flex;
                align-items: center;
                gap: 0.5rem;
            }

            .tips-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 1rem;
            }

            .tip-item {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 12px;
                padding: 1rem;
                border-left: 3px solid #4facfe;
            }

            .tip-title {
                font-weight: 600;
                color: white;
                margin-bottom: 0.5rem;
                font-size: 0.95rem;
            }

            .tip-desc {
                color: rgba(255, 255, 255, 0.8);
                font-size: 0.85rem;
                line-height: 1.4;
            }

            .form-section {
                margin-bottom: 2rem;
            }

            .form-group {
                margin-bottom: 1.5rem;
            }

            label { 
                display: block; 
                font-weight: 600; 
                margin-bottom: 0.75rem; 
                color: white;
                font-size: 1.1rem;
                display: flex;
                align-items: center;
                gap: 0.5rem;
            }

            .textarea-container {
                position: relative;
            }

            textarea { 
                width: 100%; 
                height: 200px; 
                padding: 1.5rem; 
                border-radius: 16px; 
                border: 2px solid rgba(255, 255, 255, 0.2); 
                font-size: 16px; 
                resize: vertical;
                transition: all 0.3s ease;
                font-family: inherit;
                background: rgba(255, 255, 255, 0.1);
                color: white;
                backdrop-filter: blur(10px);
            }

            textarea::placeholder {
                color: rgba(255, 255, 255, 0.6);
            }

            textarea:focus { 
                border-color: #4facfe; 
                outline: 0; 
                box-shadow: 0 0 0 0.25rem rgba(79, 172, 254, 0.25);
                transform: translateY(-2px);
                background: rgba(255, 255, 255, 0.15);
            }

            .char-counter {
                position: absolute;
                bottom: 1rem;
                right: 1rem;
                font-size: 0.85rem;
                color: rgba(255, 255, 255, 0.6);
                background: rgba(0, 0, 0, 0.3);
                padding: 0.25rem 0.5rem;
                border-radius: 6px;
                backdrop-filter: blur(5px);
            }

            .submit-button { 
                background: var(--success-gradient);
                color: white; 
                padding: 1.25rem 2rem; 
                border: none; 
                border-radius: 16px; 
                cursor: pointer; 
                font-size: 1.1rem; 
                font-weight: 600; 
                width: 100%; 
                transition: all 0.3s ease;
                position: relative;
                overflow: hidden;
                box-shadow: var(--shadow-md);
                text-transform: none;
                letter-spacing: 0.025em;
            }

            .submit-button::before {
                content: '';
                position: absolute;
                top: 0;
                left: -100%;
                width: 100%;
                height: 100%;
                background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
                transition: left 0.5s;
            }

            .submit-button:hover:not(:disabled)::before {
                left: 100%;
            }

            .submit-button:hover:not(:disabled) { 
                transform: translateY(-3px); 
                box-shadow: var(--shadow-lg);
            }

            .submit-button:disabled { 
                background: linear-gradient(135deg, #a0aec0, #718096);
                cursor: not-allowed; 
                transform: none;
                box-shadow: var(--shadow-sm);
            }

            .result-container { 
                margin-top: 2rem; 
            }

            .loading-section {
                text-align: center;
                padding: 2rem;
                display: none;
            }

            .spinner { 
                width: 50px; 
                height: 50px; 
                border: 4px solid rgba(255, 255, 255, 0.3); 
                border-top: 4px solid #4facfe; 
                border-radius: 50%; 
                animation: spin 1s linear infinite; 
                margin: 0 auto 1rem; 
            }

            @keyframes spin { 
                0% { transform: rotate(0deg); } 
                100% { transform: rotate(360deg); } 
            }

            .progress-steps {
                margin-top: 1.5rem;
                display: none;
            }

            .step {
                padding: 1rem;
                margin: 0.5rem 0;
                border-radius: 12px;
                font-size: 0.95rem;
                transition: all 0.3s ease;
                background: rgba(255, 255, 255, 0.05);
                border-left: 4px solid rgba(255, 255, 255, 0.2);
                color: rgba(255, 255, 255, 0.7);
            }

            .step.active {
                background: rgba(79, 172, 254, 0.2);
                color: #4facfe;
                border-left-color: #4facfe;
                transform: translateX(5px);
            }

            .step.completed {
                background: rgba(72, 187, 120, 0.2);
                color: #48bb78;
                border-left-color: #48bb78;
            }

            .result-success {
                background: rgba(72, 187, 120, 0.1);
                border: 1px solid rgba(72, 187, 120, 0.3);
                color: #48bb78;
                padding: 2rem;
                border-radius: 16px;
                margin-top: 1rem;
                backdrop-filter: blur(10px);
            }

            .result-error {
                background: rgba(245, 101, 101, 0.1);
                border: 1px solid rgba(245, 101, 101, 0.3);
                color: #f56565;
                padding: 2rem;
                border-radius: 16px;
                margin-top: 1rem;
                backdrop-filter: blur(10px);
            }

            .result-title {
                font-size: 1.3rem;
                font-weight: 600;
                margin-bottom: 1rem;
                display: flex;
                align-items: center;
                gap: 0.5rem;
            }

            .result-content {
                line-height: 1.6;
            }

            .result-content strong {
                font-weight: 600;
            }

            .result-url {
                color: #4facfe;
                text-decoration: none;
                font-weight: 500;
                transition: all 0.2s ease;
            }

            .result-url:hover {
                text-decoration: underline;
                color: #63b3ed;
            }

            .result-details {
                background: rgba(0, 0, 0, 0.2);
                padding: 1.5rem;
                border-radius: 12px;
                margin-top: 1rem;
                font-family: "SF Mono", "Menlo", "Monaco", "Consolas", monospace;
                font-size: 0.85rem;
                white-space: pre-wrap;
                word-wrap: break-word;
                max-height: 400px;
                overflow-y: auto;
                color: rgba(255, 255, 255, 0.8);
                border: 1px solid rgba(255, 255, 255, 0.1);
            }

            .examples-section {
                margin-top: 2rem;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 16px;
                padding: 1.5rem;
                border: 1px solid rgba(255, 255, 255, 0.1);
            }

            .examples-title {
                color: white;
                font-size: 1.1rem;
                font-weight: 600;
                margin-bottom: 1rem;
                display: flex;
                align-items: center;
                gap: 0.5rem;
            }

            .example-item {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 8px;
                padding: 1rem;
                margin-bottom: 0.75rem;
                cursor: pointer;
                transition: all 0.2s ease;
                border: 1px solid rgba(255, 255, 255, 0.1);
            }

            .example-item:hover {
                background: rgba(255, 255, 255, 0.1);
                transform: translateX(5px);
            }

            .example-title {
                font-weight: 600;
                color: white;
                margin-bottom: 0.25rem;
                font-size: 0.9rem;
            }

            .example-desc {
                color: rgba(255, 255, 255, 0.7);
                font-size: 0.8rem;
                line-height: 1.4;
            }

            @media (max-width: 768px) {
                .container { 
                    padding: 1rem; 
                }
                .main-card { 
                    padding: 2rem; 
                }
                .header h1 { 
                    font-size: 2.2rem; 
                }
                .header .subtitle {
                    font-size: 1.1rem;
                }
                textarea { 
                    height: 150px; 
                    padding: 1rem;
                }
                .feature-grid {
                    grid-template-columns: 1fr;
                }
                .tips-grid {
                    grid-template-columns: 1fr;
                }
            }

            @media (max-width: 480px) {
                .header h1 { 
                    font-size: 1.8rem; 
                }
                .main-card {
                    padding: 1.5rem;
                }
            }
        </style>
    </head>
    <body>
        <div class="background-animation"></div>
        
        <div class="container">
            <div class="main-card">
                <div class="header">
                    <h1>🚀 Lark Base AI Builder</h1>
                    <p class="subtitle">AIが自動でデータベース設計を行い、完璧なLark Baseを構築します</p>
                </div>

                <div class="feature-grid">
                    <div class="feature-card">
                        <span class="feature-icon">🤖</span>
                        <div class="feature-title">AI自動設計</div>
                        <div class="feature-desc">自然言語から最適なテーブル構造を自動生成</div>
                    </div>
                    <div class="feature-card">
                        <span class="feature-icon">⚡</span>
                        <div class="feature-title">高速構築</div>
                        <div class="feature-desc">数分でプロフェッショナルなBaseが完成</div>
                    </div>
                    <div class="feature-card">
                        <span class="feature-icon">🎯</span>
                        <div class="feature-title">精密設計</div>
                        <div class="feature-desc">業務に最適化されたフィールド設計</div>
                    </div>
                    <div class="feature-card">
                        <span class="feature-icon">📊</span>
                        <div class="feature-title">サンプルデータ</div>
                        <div class="feature-desc">すぐに使えるテストデータを自動生成</div>
                    </div>
                </div>
                
                <div class="info-section">
                    <h3>💡 効果的な指示のコツ</h3>
                    <div class="tips-grid">
                        <div class="tip-item">
                            <div class="tip-title">具体的に記述</div>
                            <div class="tip-desc">「顧客管理」ではなく「顧客名、電話番号、担当者を管理」</div>
                        </div>
                        <div class="tip-item">
                            <div class="tip-title">項目を明記</div>
                            <div class="tip-desc">管理したいデータの種類を具体的に列挙</div>
                        </div>
                        <div class="tip-item">
                            <div class="tip-title">関係性を説明</div>
                            <div class="tip-desc">テーブル間の関連があれば記述</div>
                        </div>
                        <div class="tip-item">
                            <div class="tip-title">業務フローを含める</div>
                            <div class="tip-desc">どのような流れで使用するかを説明</div>
                        </div>
                    </div>
                </div>
                
                <div class="form-section">
                    <div class="form-group">
                        <label for="prompt">📝 作成したいBaseの内容を詳しく説明してください</label>
                        <div class="textarea-container">
                            <textarea 
                                id="prompt" 
                                placeholder="例：営業チームで使う顧客管理と商談管理のBaseを作って。&#10;&#10;【顧客情報】&#10;・会社名、担当者名、電話番号、メールアドレス&#10;・業界（IT、製造業、サービス業など）&#10;・顧客ランク（A、B、C）&#10;・担当営業&#10;&#10;【商談情報】&#10;・商談名、金額、進捗状況&#10;・受注確度（高、中、低）&#10;・商談開始日、予定完了日&#10;・関連顧客"
                                maxlength="2000"
                                oninput="updateCharCounter()"
                            ></textarea>
                            <div class="char-counter" id="char-counter">0 / 2000</div>
                        </div>
                    </div>
                    
                    <button class="submit-button" id="submit-button" onclick="createBase()">
                        🤖 AIにBaseの作成を依頼
                    </button>
                </div>

                <div class="examples-section">
                    <div class="examples-title">📋 使用例</div>
                    <div class="example-item" onclick="setExample(0)">
                        <div class="example-title">営業管理システム</div>
                        <div class="example-desc">顧客情報と商談進捗を管理するCRMシステム</div>
                    </div>
                    <div class="example-item" onclick="setExample(1)">
                        <div class="example-title">プロジェクト管理</div>
                        <div class="example-desc">タスク、メンバー、進捗を一元管理</div>
                    </div>
                    <div class="example-item" onclick="setExample(2)">
                        <div class="example-title">在庫管理システム</div>
                        <div class="example-desc">商品、入出庫、在庫数を追跡管理</div>
                    </div>
                </div>
                
                <div class="result-container" id="result-container">
                    <div class="loading-section" id="loading-section">
                        <div class="spinner"></div>
                        <div style="color: white; font-weight: 500;">AIがBaseを構築中...</div>
                        <div class="progress-steps" id="progress-steps">
                            <div class="step" id="step-1">🔍 AI分析中...</div>
                            <div class="step" id="step-2">🏗️ Base作成中...</div>
                            <div class="step" id="step-3">📋 テーブル構築中...</div>
                            <div class="step" id="step-4">📊 サンプルデータ追加中...</div>
                        </div>
                    </div>
                    <div id="result"></div>
                </div>
            </div>
        </div>

        <script>
            const examples = [
                \`営業チームで使う顧客管理と商談管理のBaseを作って。

【顧客情報テーブル】
・会社名、担当者名、電話番号、メールアドレス
・業界（IT、製造業、サービス業、金融、その他）
・顧客ランク（A、B、C）
・担当営業、登録日
・住所、ウェブサイト

【商談情報テーブル】
・商談名、関連顧客、金額
・進捗状況（提案、交渉、契約、完了、失注）
・受注確度（高、中、低）
・商談開始日、予定完了日
・担当営業、備考\`,

                \`開発チーム用のプロジェクト管理Baseを作って。

【プロジェクトテーブル】
・プロジェクト名、説明、開始日、終了予定日
・ステータス（計画中、進行中、完了、保留）
・優先度（高、中、低）
・プロジェクトマネージャー、予算

【タスクテーブル】
・タスク名、説明、関連プロジェクト
・担当者、ステータス（未着手、進行中、完了）
・開始日、期限、実際の完了日
・工数（時間）、優先度

【メンバーテーブル】
・名前、役職、スキル
・メールアドレス、参加プロジェクト数\`,

                \`小売店の在庫管理システムを作って。

【商品マスタテーブル】
・商品名、商品コード、カテゴリ
・仕入価格、販売価格、メーカー
・最小在庫数、商品説明

【在庫テーブル】
・商品、現在庫数、安全在庫数
・最終入庫日、最終出庫日
・在庫状況（正常、不足、過剰）

【入出庫履歴テーブル】
・商品、入出庫区分（入庫、出庫）
・数量、日時、担当者
・備考、関連伝票番号\`
            ];

            function setExample(index) {
                document.getElementById('prompt').value = examples[index];
                updateCharCounter();
            }

            function updateCharCounter() {
                const textarea = document.getElementById('prompt');
                const counter = document.getElementById('char-counter');
                const length = textarea.value.length;
                counter.textContent = \`\${length} / 2000\`;
                
                if (length > 1800) {
                    counter.style.color = '#f56565';
                } else if (length > 1500) {
                    counter.style.color = '#ed8936';
                } else {
                    counter.style.color = 'rgba(255, 255, 255, 0.6)';
                }
            }

            function setStepStatus(stepNumber, status) {
                const step = document.getElementById(\`step-\${stepNumber}\`);
                if (!step) return;
                
                step.classList.remove('active', 'completed');
                if (status === 'active') {
                    step.classList.add('active');
                } else if (status === 'completed') {
                    step.classList.add('completed');
                }
            }

            async function createBase() {
                const promptText = document.getElementById('prompt').value.trim();
                const resultEl = document.getElementById('result');
                const loadingSection = document.getElementById('loading-section');
                const progressSteps = document.getElementById('progress-steps');
                const button = document.getElementById('submit-button');

                if (!promptText) {
                    showError('指示内容を入力してください。');
                    return;
                }

                if (promptText.length < 20) {
                    showError('指示内容が短すぎます。もう少し詳しく説明してください。');
                    return;
                }

                // UI状態をリセット
                resultEl.innerHTML = '';
                loadingSection.style.display = 'block';
                progressSteps.style.display = 'block';
                button.disabled = true;
                button.textContent = '作成中...';

                // プログレス表示
                setStepStatus(1, 'active');

                try {
                    // ステップ1: AI分析
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    setStepStatus(1, 'completed');
                    setStepStatus(2, 'active');

                    const response = await fetch('/api/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ prompt: promptText })
                    });

                    // ステップ2-4の進行表示
                    setStepStatus(2, 'completed');
                    setStepStatus(3, 'active');
                    await new Promise(resolve => setTimeout(resolve, 500));
                    setStepStatus(3, 'completed');
                    setStepStatus(4, 'active');
                    await new Promise(resolve => setTimeout(resolve, 500));
                    setStepStatus(4, 'completed');

                    const result = await response.json();

                    if (response.ok && result.success) {
                        showSuccess(result);
                    } else {
                        throw new Error(result.error || '不明なエラーが発生しました。');
                    }
                } catch (error) {
                    showError(error.message);
                } finally {
                    loadingSection.style.display = 'none';
                    button.disabled = false;
                    button.textContent = '🤖 AIにBaseの作成を依頼';
                }
            }

            function showSuccess(result) {
                const resultEl = document.getElementById('result');
                const summary = result.summary;
                
                resultEl.innerHTML = \`
                    <div class="result-success">
                        <div class="result-title">
                            ✅ Base作成完了！
                        </div>
                        <div class="result-content">
                            <p><strong>Base名：</strong> \${result.baseName}</p>
                            <p><strong>URL：</strong> <a href="\${result.baseUrl}" target="_blank" class="result-url">\${result.baseUrl}</a></p>
                            <p><strong>作成結果：</strong> \${summary.successfulTables}/\${summary.totalTables} テーブル作成成功</p>
                            \${summary.failedTables > 0 ? \`<p style="color: #ed8936;">⚠️ \${summary.failedTables}個のテーブルで問題が発生しましたが、Baseは正常に作成されました。</p>\` : ''}
                            <p style="margin-top: 1rem; font-size: 0.9rem; opacity: 0.8;">上記URLをクリックしてLark Baseにアクセスし、作成されたデータベースをご確認ください。</p>
                        </div>
                        <div class="result-details">\${JSON.stringify(result.details, null, 2)}</div>
                    </div>
                \`;
            }

            function showError(message) {
                const resultEl = document.getElementById('result');
                resultEl.innerHTML = \`
                    <div class="result-error">
                        <div class="result-title">
                            ❌ エラーが発生しました
                        </div>
                        <div class="result-content">
                            <p>\${message}</p>
                            <p style="margin-top: 1rem; font-size: 0.9rem; opacity: 0.8;">
                                問題が続く場合は、指示内容をより具体的にするか、しばらく時間をおいて再試行してください。
                            </p>
                        </div>
                    </div>
                \`;
            }

            // 初期化
            updateCharCounter();
        </script>
    </body>
    </html>
    `;

    return new Response(html, {
        headers: { 'Content-Type': 'text/html;charset=utf-8' },
    });
}

// --- Utility Functions ---

/**
 * 指定された時間だけ待機する
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Lark API Helpers ---

/**
 * AIからスキーマを生成する（完全改善版）
 */
async function generateSchemaFromAI(userPrompt, apiKey) {
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not configured.");
    }

    const apiUrl = \`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=\${apiKey}\`;

    const systemPrompt = \`あなたはLark Baseのデータベース設計専門家です。
ユーザーの要求を分析し、実用的なテーブル構造を設計してください。

重要な制約：
- 応答は必ずJSONオブジェクトのみ
- テーブル数は最大10個まで
- フィールド数は1テーブルあたり最大15個まで
- サンプルデータは最大20件まで
- 実際に使用可能なフィールドタイプのみ使用

利用可能なフィールドタイプ：
- text: テキスト
- number: 数値
- single_select: 単一選択（オプション必須）
- multi_select: 複数選択（オプション必須）
- date: 日付
- date_time: 日時
- checkbox: チェックボックス
- member: メンバー
- phone: 電話番号
- url: URL
- email: メール
- currency: 通貨
- rating: 評価\`;

    const enhancedUserPrompt = \`
以下の要求に基づいて、実用的なLark Baseのテーブル構造を設計してください：

要求内容：
"\${userPrompt}"

設計時の注意点：
1. 実際の業務で使いやすい構造にする
2. 必要最小限のテーブル数に抑える
3. 各テーブルに適切なサンプルデータ件数を設定する（0-20件）
4. 選択肢が必要なフィールドには具体的な選択肢を提供する
5. テーブル名とフィールド名は日本語で分かりやすく命名する\`;

    const payload = {
        "system_instruction": { "parts": { "text": systemPrompt } },
        "contents": [{ "parts": [{ "text": enhancedUserPrompt }] }],
        "generationConfig": {
            "response_mime_type": "application/json",
            "response_schema": {
                "type": "OBJECT",
                "properties": {
                    "baseName": { "type": "STRING" },
                    "tables": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "name": { "type": "STRING" },
                                "fields": {
                                    "type": "ARRAY",
                                    "items": {
                                        "type": "OBJECT",
                                        "properties": {
                                            "name": { "type": "STRING" },
                                            "type": { "type": "STRING" },
                                            "options": {
                                                "type": "OBJECT",
                                                "properties": {
                                                    "オプション": { "type": "STRING" }
                                                }
                                            }
                                        }
                                    }
                                },
                                "sampleDataCount": { "type": "NUMBER" }
                            }
                        }
                    }
                }
            }
        }
    };
    
    let lastError = null;
    
    // 最大5回までリトライ（完全改善版）
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const response = await fetch(apiUrl, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify(payload) 
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(\`Gemini API HTTP Error \${response.status}: \${errorText}\`);
            }
            
            const result = await response.json();

            if (!result.candidates?.[0]?.content?.parts?.[0]?.text) {
                console.error(\`Gemini API Error (Attempt \${attempt}):\`, JSON.stringify(result, null, 2));
                throw new Error(\`AIからの応答が不正です。(試行 \${attempt}/5)\`);
            }
            
            let rawText = result.candidates[0].content.parts[0].text;
            let parsedData = null;

            // 複数の方法でJSONパースを試行（完全改善版）
            try {
                // 方法1: 直接パース
                parsedData = JSON.parse(rawText);
            } catch (e1) {
                try {
                    // 方法2: マークダウンコードブロックから抽出
                    const jsonMatch = rawText.match(/\`\`\`json\\s*([\\s\\S]*?)\\s*\`\`\`/);
                    if (jsonMatch && jsonMatch[1]) {
                        parsedData = JSON.parse(jsonMatch[1]);
                    }
                } catch (e2) {
                    try {
                        // 方法3: 最初と最後の{}を見つけて抽出
                        const firstBrace = rawText.indexOf('{');
                        const lastBrace = rawText.lastIndexOf('}');
                        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                            const jsonText = rawText.substring(firstBrace, lastBrace + 1);
                            parsedData = JSON.parse(jsonText);
                        }
                    } catch (e3) {
                        throw new Error(\`JSONパースに失敗しました: \${e1.message}\`);
                    }
                }
            }
            
            if (!parsedData) {
                throw new Error('有効なJSONデータを抽出できませんでした。');
            }
            
            // データ検証（強化版）
            if (!parsedData.baseName || !parsedData.tables || !Array.isArray(parsedData.tables)) {
                throw new Error('AIの応答形式が不正です。必要なフィールドが不足しています。');
            }
            
            if (parsedData.tables.length === 0) {
                throw new Error('テーブルが生成されませんでした。指示内容をより具体的にしてください。');
            }
            
            // 成功時は即座に結果を返す
            return parsedData;

        } catch (e) {
            console.error(\`Attempt \${attempt} failed:\`, e.message);
            lastError = e;
            
            if (attempt < 5) {
                // 指数バックオフでリトライ間隔を調整
                await sleep(1000 * Math.pow(2, attempt - 1));
            }
        }
    }
    
    // すべてのリトライに失敗した場合
    console.error("すべてのリトライに失敗しました。最後のエラー:", lastError);
    throw new Error(\`AI処理に失敗しました: \${lastError.message}。指示内容をより具体的にするか、しばらく時間をおいて再試行してください。\`);
}

/**
 * Lark API呼び出し（完全改善版）
 */
async function apiCall(token, path, options = {}) {
    const { method = 'GET', body = null, retries = 3 } = options;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(\`\${LARK_API_URL}\${path}\`, {
                method,
                headers: { 
                    'Authorization': \`Bearer \${token}\`, 
                    'Content-Type': 'application/json',
                },
                body: body ? JSON.stringify(body) : null,
            });
            
            if (!response.ok) {
                if (response.status === 429) {
                    // Rate limit - 指数バックオフで待機
                    const waitTime = 1000 * Math.pow(2, attempt);
                    console.warn(\`Rate limit hit, waiting \${waitTime}ms before retry \${attempt}/\${retries}\`);
                    await sleep(waitTime);
                    continue;
                }
                throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
            }
            
            const data = await response.json();
            
            if (data.code !== 0) {
                if (data.code === 99991400 && attempt < retries) {
                    // Rate limit error - リトライ
                    await sleep(1000 * attempt);
                    continue;
                }
                throw new Error(\`Lark API Error: \${data.msg} (Code: \${data.code}, Path: \${path})\`);
            }
            
            return data;
            
        } catch (error) {
            if (attempt === retries) {
                throw error;
            }
            console.warn(\`API call attempt \${attempt} failed, retrying...\`, error.message);
            await sleep(1000 * attempt);
        }
    }
}

async function getTenantAccessToken(env) {
    if (!env.LARK_APP_ID || !env.LARK_APP_SECRET) {
        throw new Error('Lark API credentials are not configured.');
    }
    
    const response = await fetch(\`\${LARK_API_URL}/auth/v3/tenant_access_token/internal\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            app_id: env.LARK_APP_ID, 
            app_secret: env.LARK_APP_SECRET 
        }),
    });
    
    if (!response.ok) {
        throw new Error(\`Failed to get tenant access token: HTTP \${response.status}\`);
    }
    
    const data = await response.json();
    if (data.code !== 0) {
        throw new Error(\`Failed to get tenant access token: \${data.msg}\`);
    }
    
    return data.tenant_access_token;
}

async function createBaseApp(token, baseName) {
    return apiCall(token, \`/base/v1/apps\`, {
        method: 'POST',
        body: { name: baseName },
    });
}

async function addSampleRecords(token, appToken, tableId, fields, count) {
    if (count <= 0 || fields.length === 0) {
        return { data: { records: [] } };
    }
    
    const records = [];
    for (let i = 0; i < count; i++) {
        const recordFields = {};
        for (const field of fields) {
            const dummyData = generateDummyData(field.type, field.options || {}, i);
            if (dummyData !== null) {
                recordFields[field.name] = dummyData;
            }
        }
        if (Object.keys(recordFields).length > 0) {
            records.push({ fields: recordFields });
        }
    }
    
    if (records.length === 0) {
        return { data: { records: [] } };
    }
    
    // バッチサイズを制限（一度に最大10件）
    const batchSize = 10;
    const allResults = [];
    
    for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        try {
            const result = await apiCall(token, \`/base/v1/apps/\${appToken}/tables/\${tableId}/records/batch_create\`, {
                method: 'POST',
                body: { records: batch },
            });
            allResults.push(...(result.data?.records || []));
            
            // バッチ間で少し待機
            if (i + batchSize < records.length) {
                await sleep(500);
            }
        } catch (error) {
            console.warn(\`Failed to create batch \${Math.floor(i/batchSize) + 1}:\`, error.message);
        }
    }
    
    return { data: { records: allResults } };
}

function getFieldProperty(type, options) {
    const getOptions = (key = 'オプション') => {
        const opts = options[key];
        if (typeof opts === 'string' && opts) {
            return opts.split(',').map(o => ({ name: o.trim() })).filter(o => o.name);
        }
        return [];
    };
    
    const typeMap = {
        'text': { type: 1 },
        'number': { type: 2, property: { formatter: '0' } },
        'single_select': { type: 3, property: { options: getOptions() } },
        'multi_select': { type: 4, property: { options: getOptions() } },
        'date': { type: 5, property: { date_formatter: 'yyyy/MM/dd' } },
        'date_time': { type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm' } },
        'checkbox': { type: 7 },
        'member': { type: 11, property: { multiple: false } },
        'phone': { type: 13 },
        'url': { type: 15 },
        'email': { type: 23 },
        'currency': { type: 25, property: { currency_code: 'JPY', formatter: '#,##0' } },
        'rating': { type: 26, property: { symbol: 'star' } },
    };
    
    const result = typeMap[type.toLowerCase()];
    
    // 選択肢が必要なフィールドで選択肢が空の場合はデフォルト値を設定
    if ((type === 'single_select' || type === 'multi_select') && 
        (!result.property.options || result.property.options.length === 0)) {
        result.property.options = [
            { name: 'オプション1' },
            { name: 'オプション2' },
            { name: 'オプション3' }
        ];
    }
    
    return result;
}

function generateDummyData(type, options, index) {
    const i = index + 1;
    const selectOptions = (options['オプション'] || '').split(',').map(s => s.trim()).filter(s => s);
    
    switch (type.toLowerCase()) {
        case 'text': 
            return \`サンプル\${i}\`;
        case 'email': 
            return \`sample\${i}@example.com\`;
        case 'phone': 
            return \`090-1234-567\${index % 10}\`;
        case 'number': 
            return 100 + (i * 50);
        case 'currency': 
            return 10000 * i;
        case 'single_select': 
            if (selectOptions.length > 0) {
                return selectOptions[index % selectOptions.length];
            }
            return \`オプション\${(index % 3) + 1}\`;
        case 'multi_select':
            if (selectOptions.length > 0) {
                // 複数選択の場合は1-2個の選択肢を返す
                const selected = [];
                const numSelect = Math.min(2, selectOptions.length);
                for (let j = 0; j < numSelect; j++) {
                    const optIndex = (index + j) % selectOptions.length;
                    if (!selected.includes(selectOptions[optIndex])) {
                        selected.push(selectOptions[optIndex]);
                    }
                }
                return selected;
            }
            return [\`オプション\${(index % 3) + 1}\`];
        case 'date': 
        case 'date_time':
            // 過去30日から未来30日の範囲でランダムな日付
            const baseDate = new Date();
            const randomDays = (Math.random() - 0.5) * 60; // -30 to +30 days
            baseDate.setDate(baseDate.getDate() + randomDays);
            return baseDate.getTime();
        case 'checkbox': 
            return i % 2 === 0;
        case 'url': 
            return \`https://example.com/item/\${i}\`;
        case 'rating': 
            return (index % 5) + 1;
        default: 
            return null;
    }
}

