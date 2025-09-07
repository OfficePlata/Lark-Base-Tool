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
 * APIのロジックを処理する関数
 */
async function handleApiPost({ request, env }) {
     try {
        const { prompt } = await request.json();
        if (!prompt) throw new Error('Prompt is required');

        // --- Step 1: AIにBase名とテーブル構成を設計させる ---
        const aiResponse = await generateSchemaFromAI(prompt, env.GEMINI_API_KEY);
        const { baseName, tables } = aiResponse;

        if (!baseName || !tables || tables.length === 0) {
            throw new Error('AIによるBase構成の生成に失敗しました。');
        }
        
        const tenantAccessToken = await getTenantAccessToken(env);

        // --- Step 2: AIの設計に基づいて新しいBaseを作成 ---
        const createBaseRes = await createBaseApp(tenantAccessToken, baseName);
        const newAppToken = createBaseRes.data.app.app_token;
        const newBaseUrl = createBaseRes.data.app.url;

        const results = [];
        // --- Step 3: 作成されたBase内にテーブルとフィールドを構築 ---
        for (const table of tables) {
            const createTableRes = await apiCall(tenantAccessToken, `/base/v1/apps/${newAppToken}/tables`, { method: 'POST', body: { name: table.name } });
            const tableId = createTableRes.data.table_id;
            
            await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit

            for (const field of table.fields) {
                const fieldPayload = getFieldProperty(field.type, field.options || {});
                if (!fieldPayload) {
                    console.warn(`Unsupported field type: ${field.type}`);
                    continue;
                }
                await apiCall(tenantAccessToken, `/base/v1/apps/${newAppToken}/tables/${tableId}/fields`, {
                    method: 'POST',
                    body: { field_name: field.name, type: fieldPayload.type, property: fieldPayload.property }
                });
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            
            let recordsAdded = 0;
            if (table.sampleDataCount > 0) {
                const addRecordsRes = await addSampleRecords(tenantAccessToken, newAppToken, tableId, table.fields, table.sampleDataCount);
                recordsAdded = addRecordsRes.data?.records?.length || 0;
            }
            results.push({ tableName: table.name, status: 'Success', tableId, recordsAdded });
        }

        return new Response(JSON.stringify({
            message: 'New Base created successfully!',
            baseName: baseName,
            baseUrl: newBaseUrl,
            details: results
        }, null, 2), { headers: { 'Content-Type': 'application/json' } });

    } catch (error) {
        console.error("Error details:", error);
        return new Response(JSON.stringify({ error: error.message }, null, 2), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}


/**
 * フロントエンドのHTML UIを生成する関数
 */
function serveHtml() {
    const html = `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Lark Base 自動構築ツール (AI対応版)</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; padding: 20px; max-width: 800px; margin: 0 auto; background-color: #f8f9fa; color: #212529; }
            .container { background-color: #fff; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
            h1 { font-size: 2rem; color: #343a40; border-bottom: 2px solid #0d6efd; padding-bottom: 0.5rem; margin-bottom: 1.5rem; }
            label { display: block; font-weight: 600; margin-bottom: 0.5rem; color: #495057; }
            textarea { width: 100%; height: 200px; padding: 12px; border-radius: 8px; border: 1px solid #ced4da; font-size: 16px; margin-bottom: 1rem; box-sizing: border-box; resize: vertical; }
            textarea:focus { border-color: #86b7fe; outline: 0; box-shadow: 0 0 0 0.25rem rgba(13, 110, 253, 0.25); }
            button { background: linear-gradient(145deg, #0d6efd, #0a58ca); color: white; padding: 14px 24px; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem; font-weight: 600; width: 100%; transition: all 0.2s ease-in-out; }
            button:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,0.12); }
            button:disabled { background: #6c757d; cursor: not-allowed; }
            #result-container { margin-top: 1.5rem; }
            pre { background-color: #e9ecef; padding: 1rem; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; font-family: "SF Mono", "Menlo", "Monaco", "Consolas", monospace; font-size: 0.9rem; }
            .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #0d6efd; border-radius: 50%; width: 32px; height: 32px; animation: spin 1.5s linear infinite; margin: 20px auto; display: none; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Lark Base 自動構築ツール (AI対応版)</h1>
            <p>作りたいBaseの内容を、AIに分かるように具体的に指示してください。</p>
            
            <div>
                <label for="prompt">指示内容:</label>
                <textarea id="prompt" placeholder="例: 営業チームで使う顧客管理と商談管理のBaseを作って。\\n顧客ランク（A,B,C）と担当者、受注確度（高,中,低）を管理できるようにしたい。"></textarea>
            </div>
            
            <button id="submit-button" onclick="createBase()">AIにBaseの作成を依頼</button>
            
            <div id="result-container">
                <div class="spinner" id="spinner"></div>
                <pre id="result"></pre>
            </div>
        </div>

        <script>
            async function createBase() {
                const promptText = document.getElementById('prompt').value;
                const resultEl = document.getElementById('result');
                const spinner = document.getElementById('spinner');
                const button = document.getElementById('submit-button');

                if (!promptText) {
                    resultEl.textContent = 'エラー: 指示内容を入力してください。';
                    return;
                }

                resultEl.textContent = '';
                spinner.style.display = 'block';
                button.disabled = true;
                button.textContent = '作成中...';

                try {
                    const response = await fetch('/api/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ prompt: promptText })
                    });

                    const result = await response.json();

                    if (response.ok) {
                        resultEl.textContent = '✅ 作成成功！\\n\\n' + JSON.stringify(result, null, 2);
                    } else {
                        throw new Error(result.error || '不明なエラーが発生しました。');
                    }
                } catch (error) {
                    resultEl.textContent = '❌ エラーが発生しました:\\n' + error.message;
                } finally {
                    spinner.style.display = 'none';
                    button.disabled = false;
                    button.textContent = 'AIにBaseの作成を依頼';
                }
            }
        </script>
    </body>
    </html>
    `;

    return new Response(html, {
        headers: { 'Content-Type': 'text/html;charset=utf-8' },
    });
}


// --- Lark API Helpers ---
async function generateSchemaFromAI(userPrompt, apiKey) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

    const systemPrompt = `あなたはLark Baseのデータベース設計を行うAPIです。ユーザーの要求を解釈し、指定されたJSON形式のデータのみを返却します。解説や挨拶など、JSON以外のテキストは一切含めないでください。
- ユーザーの要求に最も適したBaseの名前（baseName）を提案してください。
- 日本語のフィールド名を提案してください。
- ユーザーの要求に最適なLarkのフィールドタイプを選択してください。
- single_selectやmulti_selectには、適切な選択肢（オプション）を3〜5個提案してください。
- サンプルデータ数は、3から5の間で適切に設定してください。`;

    const payload = {
        "system_instruction": { "parts": { "text": systemPrompt } },
        "contents": [{ "parts": [{ "text": userPrompt }] }],
        "generationConfig": {
            "response_mime_type": "application/json",
            "response_schema": {
                "type": "OBJECT", "properties": { "baseName": { "type": "STRING" }, "tables": { "type": "ARRAY", "items": { "type": "OBJECT", "properties": { "name": { "type": "STRING" }, "fields": { "type": "ARRAY", "items": { "type": "OBJECT", "properties": { "name": { "type": "STRING" }, "type": { "type": "STRING" }, "options": { "type": "OBJECT", "properties": { "オプション": { "type": "STRING" } } } } } }, "sampleDataCount": { "type": "NUMBER" } } } } }
            }
        }
    };
    
    let lastError = null;
    // AIの応答が不安定な場合があるため、最大3回までリトライする
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            const result = await response.json();

            if (!response.ok || !result.candidates?.[0]?.content?.parts?.[0]?.text) {
                console.error(`Gemini API Error (Attempt ${attempt}):`, JSON.stringify(result, null, 2));
                lastError = new Error("AIによるテーブル構成の生成に失敗しました。APIからの応答がありません。");
                await new Promise(res => setTimeout(res, 1000)); // 1秒待ってリトライ
                continue;
            }
            
            let jsonText = result.candidates[0].content.parts[0].text;

            // AIが稀に返すマークダウン形式をクリーンアップ
            const jsonMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```|({[\s\S]*})/);
            if (jsonMatch) {
                 jsonText = jsonMatch[1] || jsonMatch[2];
            }
            
            // JSONとしてパースを試みる
            return JSON.parse(jsonText); // 成功したら即座に結果を返す

        } catch (e) {
            console.error(`Attempt ${attempt} failed:`, e);
            lastError = e;
            await new Promise(res => setTimeout(res, 1000)); // 1秒待ってリトライ
        }
    }
    
    // 3回試行しても失敗した場合、最後のエラーを投げる
    console.error("すべてのリトライに失敗しました。");
    throw new Error(`AIの応答処理に失敗しました: ${lastError.message}`);
}


async function apiCall(token, path, options = {}) {
    const { method = 'GET', body = null } = options;
    const response = await fetch(`${LARK_API_URL}${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', },
        body: body ? JSON.stringify(body) : null,
    });
    const data = await response.json();
    if (data.code !== 0) {
        throw new Error(`Lark API Error: ${data.msg} (Code: ${data.code}, Path: ${path})`);
    }
    return data;
}

async function getTenantAccessToken(env) {
    const response = await fetch(`${LARK_API_URL}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: env.LARK_APP_ID, app_secret: env.LARK_APP_SECRET }),
    });
    const data = await response.json();
    if (data.code !== 0) throw new Error('Failed to get tenant access token');
    return data.tenant_access_token;
}

async function createBaseApp(token, baseName) {
    return apiCall(token, `/base/v1/apps`, {
        method: 'POST',
        body: { name: baseName },
    });
}

async function addSampleRecords(token, appToken, tableId, fields, count) {
    const records = [];
    for (let i = 0; i < count; i++) {
        const recordFields = {};
        for (const field of fields) {
            const dummyData = generateDummyData(field.type, field.options || {}, i);
            if (dummyData !== null) recordFields[field.name] = dummyData;
        }
        if (Object.keys(recordFields).length > 0) records.push({ fields: recordFields });
    }
    if (records.length === 0) return { data: { records: [] } };
    return apiCall(token, `/base/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
        method: 'POST',
        body: { records },
    });
}

function getFieldProperty(type, options) {
    const getOptions = (key = 'オプション') => (options[key] || '').split(',').map(o => ({ name: o.trim() }));
    const map = {
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
    return map[type.toLowerCase()];
}

function generateDummyData(type, options, index) {
    const i = index + 1;
    const selectOptions = (options['オプション'] || '').split(',');
    switch (type.toLowerCase()) {
        case 'text': return `サンプル ${i}`;
        case 'email': return `sample${i}@example.com`;
        case 'phone': return `090-1234-567${index % 10}`;
        case 'number': return 123 * i;
        case 'currency': return 5000 * i;
        case 'single_select': return selectOptions.length > 0 && selectOptions[0] ? selectOptions[index % selectOptions.length].trim() : null;
        case 'date': return Date.now();
        case 'date_time': return Date.now();
        case 'checkbox': return i % 2 === 0;
        case 'url': return `https://example.com/item/${i}`;
        case 'rating': return (index % 5) + 1;
        default: return null;
    }
}

