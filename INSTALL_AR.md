# طريقة التثبيت

## 1. المتطلبات
ثبّت **Node.js بإصدار 20 أو أحدث** من https://nodejs.org (اختر نسخة LTS).

## 2. التثبيت
فكّ ضغط الملف، ثم:

- **على Windows:** انقر مرتين على `install.bat`
- **على Mac / Linux:** افتح Terminal داخل المجلد واكتب `./install.sh`

سيقوم السكربت بما يلي:
1. يتحقق من وجود Node.js.
2. ينشئ ملف الإعدادات `.env` بكلمات سرية عشوائية.
3. يعرض **مفتاحك المحلي** (`sk-local-...`). احتفظ به، فهو المفتاح الذي تستعمله برامجك للاتصال بالخادم.
4. يشغّل اختباراً ذاتياً سريعاً.
5. يعرض عليك إضافة مفتاح مزوّد مجاني.

> **مهم:** احتفظ بنسخة من ملف `.env`، فبدونه لا يمكن فك تشفير مفاتيحك المخزّنة.

## 3. الحصول على مفتاح مجاني
| المزوّد | الاسم في البرنامج | الموقع |
|---|---|---|
| Groq | `groq` | console.groq.com |
| Google Gemini | `gemini` | aistudio.google.com |
| Mistral | `mistral` | console.mistral.ai |
| OpenRouter | `openrouter` | openrouter.ai |
| Cerebras | `cerebras` | cloud.cerebras.ai |

لإضافة مفاتيح أخرى لاحقاً، افتح Terminal داخل المجلد واكتب:
```
node src/cli.js keys add groq
```
ثم الصق المفتاح واضغط Enter.

## 4. التشغيل
- **Windows:** انقر مرتين على `start.bat`
- **Mac / Linux:** `./start.sh`

يعمل الخادم على العنوان `http://127.0.0.1:8787/v1`، ويمكن لأي برنامج يدعم OpenAI أن يستعمله. اختر `model` = `auto`، وضع مفتاحك المحلي في خانة المفتاح.

للتجربة:
```
curl http://127.0.0.1:8787/v1/chat/completions -H "Authorization: Bearer مفتاحك_المحلي" -H "Content-Type: application/json" -d "{\"model\":\"auto\",\"messages\":[{\"role\":\"user\",\"content\":\"مرحبا\"}]}"
```

## مشاكل شائعة
- **`node` غير معروف:** لم يُثبَّت Node.js، أو تحتاج إلى إعادة تشغيل الحاسوب بعد تثبيته.
- **`FREELLM_MASTER_KEY does not match`:** ملف `.env` تغيّر بعد إضافة المفاتيح. استرجع نسخته القديمة.
- **`No provider can take this request`:** لم تُضف أي مفتاح، أو أن كل المفاتيح وصلت إلى حدودها المجانية مؤقتاً.
