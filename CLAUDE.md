# GoBoost Platform — Vision & Working Document

> **קרא אותי בתחילת כל סשן.** זה ה-source of truth של הפרויקט החדש (`goboost-platform`) — fork של Paperclip עם שכבת GoBoost מעליו.

---

## 1. מהות הפרויקט

**GoBoost Platform היא Agent Runtime Platform לארגונים ועסקים ישראליים — fork של Paperclip עם UI ויזואלי בעברית, wizards לבעלי עסקים, presets לסקטורים ישראליים, ו-integration playbook לאינטגרטור.**

הליבה הטכנית של orchestration (tasks, hierarchies, adapters, skills) מגיעה מ-Paperclip. ה-IP הייחודי שלנו = השכבה שמעליה: UI עברית RTL, ויזואליזציה של משרד, wizards, sector presets, וכלים ישראליים.

---

## 2. מודל עסקי — מי אנחנו (לא מי אנחנו רוצים להיות בעוד 5 שנים, אלא **עכשיו**)

**אנחנו אינטגרטור.** לא חברת מוצר SaaS, לא יוניקורן. המוצר הזה הוא הקלף הראשון שלנו לאחר זה:

1. ארגונים מקבלים את GoBoost Platform — מותקן על השרת שלהם (self-hosted)
2. הם משלמים על הליווי, ההתקנה, וההתאמה לסקטור שלהם
3. ברגע שאנחנו "ה-trusted" שלהם — נכנסים פרויקטים נוספים: שרתי LLM פנימיים, חיבורי CRM/ERP, אינטגרציה עם מערכות קיימות (Monday, SAP, Priority)
4. בעתיד — partnerships עם Monday.com / SAP / Priority כ-implementation partner

**המודל הזה מכתיב את הארכיטקטורה:** self-hosted-first, customer owns data, אנחנו מספקים software + ליווי. אין מרכזיות, אין SaaS multi-tenant.

---

## 3. ארכיטקטורה — 3 שכבות

```
┌──────────────────────────────────────────────────────┐
│  GoBoost Layer (ה-IP שלנו — UI + תוכן ישראלי)         │
│  Hebrew RTL UI │ Office Visualization │ Wizards       │
│  Sector Presets │ Israeli Tools │ Integration Playbook │
├──────────────────────────────────────────────────────┤
│  Paperclip Core (fork — engine)                       │
│  Tasks │ Org Chart │ Skills │ Adapters │ Heartbeats   │
│  Cost Tracking │ Governance │ Plugin System           │
├──────────────────────────────────────────────────────┤
│  Adapters (per agent runtime)                         │
│  Claude SDK │ Hermes Agent │ Claude Code │ ...        │
└──────────────────────────────────────────────────────┘
```

### 3.1 GoBoost Layer (ה-IP שלנו, 100% שלנו)

מה ש**רק אנחנו עושים** — לא ב-Paperclip, לא ב-Hermes, לא ב-OpenClaw:

- **Hebrew RTL UI מלא** — כל מילה בעברית, כל layout RTL-aware
- **Office Visualization ("Computer game" paradigm)** — Phaser scene של משרד עם דמויות, חדרים, אנימציות. **זה לא IP אבל זה משמעותי מאוד לשוק:** הלקוח מדבר עם משהו ויזואלי שעונה, מציג הודעות כאילו הוא מדבר, מפעיל כלים בצורה נראית — לא עם dashboard שמדפיס לו משימות בחלון אחר. ההבדל קריטי לקשר רגשי, לקלות מכירה, ול-wow מהיר. **Paperclip's UI הוא dashboard מתקדם — שלנו צריך להיות "Tycoon-like" experience.** ב-future נשתמש בנכסי [pixel-agents](https://github.com/pablodelucca/pixel-agents) (Metro City sprite pack, MIT) להעלאת רמת הגימור.
- **5-Layer Tool Visualization Bridge** — chat pill + badge + action icon + bubble narration + side panel (כשסוכן מפעיל כלי, כל 5 השכבות נדלקות מנקודה אחת)
- **Wizards לבעלי עסקים ישראליים** — Company Wizard, Agent Builder, Sector Selector
- **Sector presets** — משרד עו"ד, רואי חשבון, מרפאה, חברת תוכנה, etc. עם brain seed עשיר, agents מוגדרים, tools מותאמים
- **Israeli tools pack** — חשבונית ירוקה, מורנינג, Gmail RTL, Google Calendar עברית, Priority
- **Integration playbook** — methodology לאינטגרטור: מ-discovery call ל-onboarding ל-go-live

### 3.2 Paperclip Core (fork — לא לגעת ללא סיבה)

מה ש**Paperclip מספק לנו חינם** ולא נשכפל:

- Task system עם heartbeats, scheduling, status machine
- Org chart + hierarchy management
- Adapter registry (Claude Code, Codex, OpenClaw, bash, יותר עתידיים)
- Skills management + sync layer
- Cost tracking + budgets per agent
- Governance — approvals, audit logs, rollback
- Plugin system לכלים חיצוניים
- HTTP API + base React UI
- PostgreSQL persistence

**חוק:** אם פיצ'ר קיים ב-Paperclip — לא לשכפל. אם צריך התאמה — לתקן upstream ב-fork ולא לבנות מקביל.

### 3.3 Adapters Layer

ה-adapter contract מ-Paperclip: `execute`, `testEnvironment`, `detectModel`, `listSkills`, `syncSkills`, `sessionCodec`.

| Adapter | סטטוס | מקור |
|---|---|---|
| **Claude Code** | יש ב-Paperclip מובנה | upstream |
| **Hermes Agent** | יש adapter מוכן (`hermes-paperclip-adapter`) | Nous Research |
| **Claude SDK (Anthropic direct)** | לבנות | אנחנו (מבוסס ה-prototype הקודם) |
| **OpenAI / Gemini** | future | לפי דרישת לקוח |

---

## 4. מתודולוגיות שאסור לאבד בפורט (ה-learnings מה-prototype)

הדברים האלה גילינו בדרך הקשה ב-`goboost-ai-platform`. בפורט ל-Paperclip צריך לוודא שהם משתמרים — או דרך התאמה ל-Paperclip's model, או דרך layer נוסף ב-GoBoost Layer.

### 4.1 Planning חובה לכל בקשה
תכנון של task הוא **חובה** — גם לבקשה שנראית פשוטה (קובץ אחד). אסור לדלג על שלב planning. **למה:** במקרים אמיתיים גם מסמך יחיד מכיל מספר מקורות מידע ורכיבים שצריכים להירכב. תכנון איכותי מציל מ-rework. **לחתוך:** ceremony churn (קריאות חוזרות ל-`query_brain`, decompose ואז decompose שוב). לא לחתוך את ה-planning עצמו.

### 4.2 Office-Runner 4-Step Ritual
Worker שמפעיל כלי ייצור (Word/Excel/PDF) **חייב** לעקוב אחר 4 שלבים:
1. **הצהרה** — משפט קבוע "אני הולך ליצור [סוג] בשם [X] באמצעות [tool]"
2. **קריאה** — חייב להיות הכלי שהצהיר עליו, לא להחליף דעה
3. **אימות** — בדיקה שהסיומת + כותרת תואמים ל-slice
4. **סיום** — `complete_task` עם attachment_id מאומת או דיווח כשל

**למה:** Anthropic models שמקבלים יותר מכלי אחד באותו תחום (create_word + create_excel) נוטים להיתפס ל"מה שמוכר/אחרון" אם אין re-anchoring על ה-slice. הריטואל מכריח re-read.

### 4.3 Slice מ-Plan, לא מ-Manager Free Text
כש-manager מאציל ל-worker, ה-slice ש-worker רואה חייב להיות **`step.description` מהתוכנית**, לא ה-`task` החופשי שה-LLM של ה-manager בחר להעביר. **למה:** ה-plan הוא source of truth. ה-`task` החופשי יכול להיות vague או להתבלבל בין steps. ראינו בפועל: sub-agent ל-step-2 קיבל instruction מעורפל וביצע את step-1 בטעות.

### 4.4 Cross-Iteration Tool Fire Gate
Sub-agent (depth>0) מקבל גישה ל-**יריית כלי אמיתי אחת לכל delegation**. כל יריית כלי נוספת — בין אם parallel באותו response או sequential ב-iteration הבא — נחסמת עם synthetic error tool_result. **למה:** למנוע "and also let me make a 2nd file" failure mode.

### 4.5 Memory Taxonomy — 3 שכבות נפרדות
חיוני להפנים. בלי הפרדה ברורה, מידע ידלוף בין השכבות והמערכת תתבלבל.

| Layer | Lifetime | Scope | מקור |
|---|---|---|---|
| **Conversation Memory** | ארעי, per-thread | per-agent + per-conversation | session של ה-LLM |
| **Brain (Organizational)** | persistent, חוצה שיחות | משותף לכל הסוכנים | brain store + מקורות חיצוניים |
| **World State** | ephemeral runtime | משותף לרינדור | hierarchy store, agent runtime |

**כללי הברזל:**
- Conversation ארעית — תפוג כשהסשן נסגר, לא מתפזרת לסוכנים אחרים
- Brain persistent ומשותף — רק דברים שצריכים להיזכר לתמיד וגם לסוכנים אחרים נכתבים אליו
- World State ephemeral — משתנה כל second, שירות לרינדור בלבד

**הכלל הפשוט:** אם זה צריך להיות ידוע מחר על ידי סוכן אחר → Brain. אחרת → Conversation.

### 4.6 כל פעולה גלויה ב-UI
אין silent state changes. כל פעולה של כל סוכן צריכה להיות נראית למשתמש דרך ה-5-layer viz.

---

## 5. כללי קוד וארכיטקטורה

### Code rules
1. TypeScript strict — ללא `any`, ללא `ts-ignore`
2. עברית RTL בכל ה-UI החדש שאנחנו מוסיפים
3. אין `dangerouslyAllowBrowser` — LLM calls עוברים דרך Plugin Host / Paperclip backend
4. אין lib חדש בלי הצדקה
5. כל שינוי ב-Paperclip core — דרך fork-aware patches, לא god rewrites

### Architecture rules
1. Hierarchy של Paperclip — לא להמציא מקבילה משלנו
2. Adapter contract של Paperclip = הסטנדרט — לא לבנות interface חלופי
3. כל סוכן חדש מקבל AgentProfile + מנוטרל ל-adapter קיים — לא לכתוב runtime חדש
4. Brain = single source of truth ארגוני, לא per-agent state
5. Tools = side effects in the world, NOT inter-agent communication (זה תפקיד ה-adapter+delegation)

### Content rules
1. כל סוכן עם AgentProfile מלא (Soul + Skills + Document + Tools)
2. כל כלי עם schema מלא תואם Paperclip skills format
3. כל סקטור עם preset מלא (sector template + initial brain state + agents מוגדרים)
4. כל הכלים והכלי-mocks בעברית

### UX rules
1. Hebrew RTL הוא לא optional — כל UI חדש חייב להיבדק ב-RTL לפני merge
2. כל decision point = שאלה ברורה למשתמש בעברית
3. כל פעולה משמעותית = אישור (level: MANAGER / CRITICAL / HUMAN)
4. כל error = הודעה ברורה בעברית, לא stack trace

---

## 6. Roadmap Horizons

תכנון מפורט קיים רק ל-2-3 phases הקרובים (תחת `docs/goboost/PHASES/`). horizon מתואר במשפט-שניים, פאזות יוגדרו כשמתקרבים אליהן. **אין הערכות זמן.** Horizons מוגדרים לפי **תוצאות שמתבססות אחת על השנייה** — ה-next מתחיל רק כשה-previous הושלם, אבסולוטית.

### Horizon 1 — Foundation
**Trigger:** מתחילים מיד.
**Done when:** GoBoost Platform רץ local עם Paperclip + Hermes adapter + תוכן ראשוני, ויזואליזציה בסיסית, UI עברית. רמת feature parity עם ה-prototype הקודם.

- Phase 1 — Foundation Import (fork + understand + run)
- Phase 2 — UI Wrapper (Hebrew RTL + Visualization base)
- Phase 3 — Methodology Port (4-step ritual, content, slice-from-plan)

### Horizon 2 — Demo-Ready
**Trigger:** Horizon 1 done.
**Done when:** Demo של 30 דקות שסוגר פגישת follow-up. סקטור ישראלי מלא + WhatsApp plugin + sector preset שגורם wow.

### Horizon 3 — First Paying Client
**Trigger:** Horizon 2 done + יש לקוח חתום.
**Done when:** לקוח ראשון מריץ self-hosted על שרת שלו. docker-compose עובד. onboarding workshop template מוכן.

### Horizon 4 — Integrator Toolkit
**Trigger:** Horizon 3 done + יש partner חתום או הסכמה לגייס.
**Done when:** partner ראשון יכול להטמיע בלעדינו. training material, presets עמוקים, knowledge files retrieval, cost tracking, admin panel.

### Horizon 5 — Strategic Position
**Trigger:** Horizon 4 done + לקוחות אקטיביים בייצור.
**Done when:** Position מובהק בשוק ישראלי. MCP full, CRM/ERP starter packs, OpenAI/Gemini adapters, on-prem LLM playbook, NVIDIA OpenShell future option.

---

## 7. עבודה עם המסמך הזה

### בכל סשן חדש
1. קרא את חלקים 1-3 (מהות, מודל, ארכיטקטורה) — תמיד
2. קרא את חלק 4 (מתודולוגיות) — תמיד, זה ה-learnings הכי יקרים
3. קרא את ה-Phase הנוכחי שאנחנו עובדים בו (תחת `docs/goboost/PHASES/`)
4. בכל ספק — שאל לפני קוד

### עבודה לפי תהליכים, לא לפי זמן
**אין הערכות זמן בתכנון.** לא ימים, לא שבועות, לא חודשים. כל phase = רצף שלבים שמתבססים אחד על השני. כל שלב מתחיל רק כשהשלב הקודם **באמת הושלם** (לפי Definition of Done, לא לפי "מספיק"). אם שלב לוקח יותר ממה שחשבנו — זה לא איחור. אם פחות — לא חוסכים זמן, פשוט מתקדמים לשלב הבא.

### אם המסמך הזה לא תואם לקוד
- הקוד הוא האמת
- אבל אל תתעלם — זה אומר שהמסמך צריך עדכון
- העלה לפני שמתקדמים

### אם נתקלת ב-Paperclip core שלא ברור איך עובד
- לפני שמשנים — לקרוא את הקוד שלהם
- לפני שמשכפלים פיצ'ר — לבדוק אם כבר קיים אצלם
- ספק = שאלה ב-issue ב-fork לפני pull request חיצוני

### עדכון המסמך
- אחרי כל phase שמסתיים — לעדכן את ה-Horizon
- אחרי learning משמעותי — להוסיף לחלק 4 (מתודולוגיות)
- אחרי שינוי באסטרטגיה — לעדכן את חלקים 2-3
