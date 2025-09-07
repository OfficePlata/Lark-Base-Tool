// Lark APIのベースURL
const LARK_API_URL = 'https://open.larksuite.com/open-apis';

export async function onRequestPost({ request, env }) {
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
        }, null, 2), { headers: { 'Content-Type': 'application/json' } }); // 整形して表示

    } catch (error) {
        console.error("Error details:", error);
        return new Response(JSON.stringify({ error: error.message }, null, 2), { status: 500, headers: { 'Content-Type': 'application/json' } }); // 整形して表示
    }
}

// --- AI Schema Generation ---
async function generateSchemaFromAI(userPrompt, apiKey) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

    const systemPrompt = `あなたはLark Baseのデータベース設計の専門家です。ユーザーからの曖昧な要求を解釈し、Lark Baseの名前とテーブル構成をJSON形式で出力します。
- ユーザーの要求に最も適したBaseの名前（baseName）を日本語で提案してください。
- 日本語のフィールド名を提案してください。
- ユーザーの要求に最適なLarkのフィールドタイプを選択してください。
- single_selectやmulti_selectには、適切な選択肢（オプション）を3〜5個提案してください。
- サンプルデータ数は、3から5の間で適切に設定してください。
- 必ず指定されたJSONスキーマに従って、JSONオブジェクトのみを出力してください。他のテキストは含めないでください。`;

    const payload = {
        "system_instruction": { "parts": { "text": systemPrompt } },
        "contents": [{ "parts": [{ "text": userPrompt }] }],
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
                                                "properties": { "オプション": { "type": "STRING" } }
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

    const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();

    if (!response.ok || !result.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.error("Gemini API Error:", JSON.stringify(result, null, 2));
        throw new Error("AIによるテーブル構成の生成に失敗しました。APIエラーを確認してください。");
    }
    return JSON.parse(result.candidates[0].content.parts[0].text);
}

// --- Lark API Helpers ---

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

