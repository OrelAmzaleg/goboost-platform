# Phase 1 — Foundation Import

**יעד:** GoBoost Platform רץ local על המכונה שלנו — fork של Paperclip + Hermes adapter מותקנים, ה-React UI הדיפולטי שלהם נטען, ויש לנו מסמך הבנה מקיף לאיך הקוד שלהם בנוי.

---

## למה זה ה-Phase הראשון

הקו המנחה: **לא נוגעים בקוד שלהם לפני שאנחנו מבינים אותו.** כל ניסיון לפורט feature שלנו לפני שיודעים איך Paperclip חושב על Task / Agent / Adapter — סופו refactor כפול. השלב הזה הוא 80% קריאה ומיפוי, 20% setup.

---

## Deliverables

ב-end of phase, אלה הקבצים והמצבים שצריכים להתקיים:

1. **Fork חי של Paperclip** ברפו `goboost-platform` (private)
2. **`upstream` remote** מוגדר ל-`paperclipai/paperclip` כדי לסנכרן בעתיד
3. **README ראשוני** עם attribution + הסבר ההפרדה GoBoost layer / Paperclip core
4. **התקנה מקומית** עובדת — `pnpm install`, `pnpm dev`, ה-UI נטען ב-browser
5. **PostgreSQL local** מותקן ורץ, Paperclip מתחבר
6. **API key של Anthropic** מוגדר ב-`.env` — adapter דיפולטי של Claude עובד
7. **Hermes Agent מותקן** + `hermes-paperclip-adapter` רשום ב-Paperclip
8. **First successful run** — יצירת Company בסיסית, agent יחיד, task פשוט שמסתיים בהצלחה
9. **`docs/ARCHITECTURE-MAP.md`** — מסמך 5-10 עמודים שמתאר את ה-codebase של Paperclip כפי שאנחנו מבינים אותו
10. **`docs/MIGRATION-FROM-PROTOTYPE.md`** — רשימה מפורטת של מה מ-`goboost-ai-platform` מועבר, לאן, ובאיזה Phase

---

## Process Steps (כל שלב מתבסס על הקודם)

### שלב 1 — Foundation Setup

**Trigger:** מתחילים מיד.
**Done when:** הרפו קיים, Paperclip רץ local, ה-UI נטען ב-browser, יש חיבור DB.

- [ ] יצירת רפו `goboost-platform` ב-GitHub (private) דרך gh CLI
- [ ] `gh repo fork paperclipai/paperclip --clone --org [account]` או fork ידני + clone
- [ ] הגדרת `upstream` remote ל-`paperclipai/paperclip`
- [ ] קריאת `README.md` + `doc/DEVELOPING.md` של Paperclip לעומק
- [ ] קביעה: Node 20+ מותקן, pnpm זמין
- [ ] `pnpm install` — וידוא שהכל מתקין נקי
- [ ] התקנת PostgreSQL local (Docker container או native)
- [ ] הרצת migrations של Paperclip
- [ ] קונפיגורציה של `.env` עם API key של Anthropic
- [ ] `pnpm dev` — הרצת ה-server + ה-UI, וידוא טעינה ב-`localhost:3100`

### שלב 2 — Hermes Adapter Wiring

**Trigger:** שלב 1 done — Paperclip רץ local.
**Done when:** Hermes adapter רשום, task פשוט מסתיים דרך Hermes.

- [ ] קריאת `README.md` ו-`AGENTS.md` של `hermes-paperclip-adapter` לעומק
- [ ] `pip install hermes-agent` (או הוראות התקנה מהריפו)
- [ ] קונפיגורציה של `~/.hermes/config.yaml` עם מודל ו-API key
- [ ] `npm install hermes-paperclip-adapter` (או `pnpm`)
- [ ] רישום ה-adapter ב-Paperclip's adapter registry (לפי הוראות ה-README שלהם)
- [ ] בדיקת `testEnvironment()` — וידוא שה-environment תקף
- [ ] `detectModel()` — וידוא שהמודל מזוהה
- [ ] יצירת Company בסיסית עם agent יחיד שמשתמש ב-Hermes adapter
- [ ] הרצת task פשוט ("write a one-line haiku") דרך Hermes — וידוא שזה מסתיים

### שלב 3 — Deep Read של Paperclip Core

**Trigger:** שלב 1 done (אפשר במקביל לשלב 2).
**Done when:** `docs/ARCHITECTURE-MAP.md` קיים ומכסה את כל 11 הרכיבים מתחת.

הקריאה הזו היא ה-Deliverable העיקרי של Phase 1. **לא מתקדמים לשלב 4 לפני שזה מסתיים באמת.**

- [ ] **Map של תיקיות:** מה יש איפה. כתב למעלה במסמך `docs/ARCHITECTURE-MAP.md`
- [ ] **Task model:** איך Paperclip מגדיר task, מה הסטטוסים, איך moving בין steps, איך נכתב לdb
- [ ] **Agent model:** איך agent מוגדר, איפה ה-profile מאוחסן, איך הוא מקושר ל-adapter
- [ ] **Adapter contract:** קריאת `execute`, `testEnvironment`, `detectModel`, `listSkills`, `syncSkills`, `sessionCodec` ב-`hermes-paperclip-adapter` כדוגמה
- [ ] **Skills format:** איך skill מוגדר, איפה הוא נשמר (DB? filesystem?), איך הוא מסתנכרן ל-adapter
- [ ] **Org chart:** איך hierarchy מתבטא, איך delegation עובדת ביניהם
- [ ] **Heartbeats:** מה זה, איך הם מתוזמנים, מתי הם רצים
- [ ] **Cost tracking:** איפה נשמר usage, איך מחושב cost, איך מוצג
- [ ] **Governance:** איך approvals עובדים, איפה audit log
- [ ] **React UI structure:** איך ה-frontend בנוי, מה הקומפוננטות הראשיות, איך מתקשר עם ה-backend
- [ ] **API endpoints:** רשימה של ה-routes הראשיים שה-UI קורא להם

### שלב 4 — Compare & Map ל-Prototype

**Trigger:** שלב 3 done — יש לנו הבנה מלאה של Paperclip.
**Done when:** `docs/MIGRATION-FROM-PROTOTYPE.md` מכיל החלטות מלאות לכל רכיב.

- [ ] עוברים על כל פיצ'ר ב-`goboost-ai-platform` ושואלים: "האם זה קיים ב-Paperclip? איפה?"
- [ ] בניית טבלת mapping ב-`docs/MIGRATION-FROM-PROTOTYPE.md`:
  - שמאל: רכיב ב-prototype (Hierarchy, Task model, Delegation, etc.)
  - אמצע: מקבילה ב-Paperclip (אם יש)
  - ימין: החלטה — Port (יש מקבילה, נתאים), Replace (יש מקבילה, נחליף), Add (אין מקבילה, נוסיף), Drop (לא נחוץ יותר)

### שלב 5 — Stabilize

**Trigger:** שלבים 1-4 done.
**Done when:** Phase 1 Definition of Done מתקיים, אין bugs פתוחים, סשן הבדיקה הסופית עבר.

- [ ] תיקון כל מה שלא עבד בשלבים הקודמים
- [ ] וידוא ש-Hermes runs reliably (לא רק one-off)
- [ ] בדיקה: שני agents שונים, task אחד מאצל לשני
- [ ] עדכון `docs/ARCHITECTURE-MAP.md` עם כל מה שגילינו תוך כדי
- [ ] קריאה של `CLAUDE.md` (זה המסמך הזה) ועדכון אם הגענו להבנות חדשות

---

## Definition of Done

Phase 1 הוא "done" כשכל אלה מתקיימים:

1. ✅ `pnpm dev` מעלה את GoBoost Platform local
2. ✅ ה-UI הדיפולטי של Paperclip נטען ב-browser
3. ✅ ניתן ליצור Company, agent, task — דרך ה-UI שלהם
4. ✅ Task פשוט רץ דרך Claude adapter בהצלחה
5. ✅ Task פשוט רץ דרך Hermes adapter בהצלחה
6. ✅ `docs/ARCHITECTURE-MAP.md` קיים עם תיאור של 11 הרכיבים משלב 3
7. ✅ `docs/MIGRATION-FROM-PROTOTYPE.md` קיים עם טבלת mapping מלאה
8. ✅ Commit נקי + push ל-`origin/main` של `goboost-platform`

---

## פתוחות / החלטות שיוכרעו תוך כדי

- **שם branch לעבודה שלנו** — `main` או `goboost-main`? (אם רוצים sync עם upstream דרך `main` ייעודי, צריך לעבוד ב-branch אחר)
- **PostgreSQL ב-production:** docker container או managed? (לקוחות יצטרכו לבחור — נכתוב את שניהם בהוראות)
- **גרסת Node:** Paperclip דורש 20+. לוודא שה-deployment scripts תואמים
- **גרסת Python:** Hermes דורש 3.10+. ב-self-hosted אצל לקוחות זו דרישה — נוסיף ל-prerequisites
- **האם להתחיל לפתח כבר ClaudeAdapter ל-Anthropic SDK?** — לא ב-Phase 1. נראה אם Paperclip's Claude Code adapter מספיק לנו זמנית.

---

## אם תוך כדי גילינו ש...

- **Paperclip לא תומך בעברית בכלל ב-UI שלהם:** Phase 2 הופך ל-major (החלפה מלאה של ה-UI, לא wrap). נעדכן את Phase 2 לפי הממצא.
- **Hermes adapter דורש Python sidecar בצורה שלא תעבוד ב-Windows:** נציין כ-blocker ונחליט אם לפתח עוקף או לעבור ל-Claude Code adapter קודם.
- **Task model של Paperclip מאוד שונה משלנו (אין success_criteria, אין expected_output):** Phase 3 הופך לארוך — נצטרך להוסיף לאן ש-Paperclip לא הולך. נשקול patch upstream.
- **השתמש ב-Postgres נראה כבד מדי ל-self-hosted אצל לקוחות קטנים:** נחפש אם Paperclip תומך ב-SQLite (פחות סביר אבל אפשרי).

---

## מה הולך אחרי Phase 1

Phase 2 — UI Wrapper. בונים את שכבת ה-UI שלנו: Hebrew, RTL, ויזואליזציית משרד, wizards. אבל לא לפני שאנחנו יודעים בדיוק עם מה אנחנו עובדים. זה מה ש-Phase 1 נותן.
