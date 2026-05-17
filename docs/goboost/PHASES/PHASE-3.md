# Phase 3 — Methodology Port + Israeli Content Pack

**יעד:** המתודולוגיות שגילינו ב-prototype משובצות בשכבת GoBoost מעל Paperclip, והפלטפורמה מגיעה ל-feature parity עם המקום שהיינו ב-`goboost-ai-platform` — וגם מעבר. תוכן ישראלי ראשון מותקן ועובד.
**Trigger:** Phase 2 done.

---

## Why this Phase

עד עכשיו (Phases 1-2) בנינו תשתית: ה-fork רץ, ה-UI שלנו במקום, ויזואליזציה ראשונית עובדת. אבל הסוכנים עצמם **עוד לא מתנהגים כמו שלמדנו שהם צריכים להתנהג**. הריטואל של 4 צעדים, ה-slice מהתוכנית, ה-cross-iteration gate — כל אלה learnings שעלו לנו שבועות לגלות ב-prototype. אם נדלג עליהם בפורט, נחזור על אותם bugs.

זה גם ה-Phase שמכניס תוכן ישראלי אמיתי — כלים, sector presets, agent profiles בעברית עשירה.

---

## Deliverables

### Methodology (התנהגות של סוכנים)

1. **Office Runner Worker template** — pattern לכל sub-agent שמפעיל כלי ייצור (Word/Excel/PDF):
   - System prompt עם 4-step ritual (announce → tool → verify → complete)
   - Slice-from-plan enforcement (לא לסמוך על free-text של ה-manager)
   - Verify step: בדיקת shape/extension לפני close

2. **Cross-iteration tool fire gate** ב-adapter level (אם Paperclip לא חוסם):
   - Worker מקבל גישה ליריית כלי אמיתי אחת לכל delegation
   - יריות נוספות (parallel או sequential) — synthetic error tool_result
   - אם Paperclip's adapter כבר תומך בזה — נסמוך עליו
   - אם לא — patch ב-fork או wrapper ב-GoBoost layer

3. **Step-scoped success criteria** (אם Paperclip לא תומך):
   - כל step בתוכנית יכול להחזיק criteria משלו (`step_id`-tagged)
   - sub-agent רואה רק criteria רלוונטיים לשלב שלו + global
   - port מ-`Delegation.ts` של prototype

4. **Revision retry brief** (אם Paperclip לא תומך):
   - כש-manager מבקש revision מ-sub-agent, brief החדש מוביל ב-feedback
   - "זוהי קריאת רוויזיה לאותו שלב — הפעם הקודמת לא עברה"

### Content (תוכן ישראלי)

5. **Sector Preset #1: משרד עו"ד** (deep) — preset שלם:
   - Brain seed: 30+ entities (מדיניות חברה, סוגי תיקים, תהליכי lifecycle של תיק, רשימות לקוחות mock, חוקים רלוונטיים)
   - 4-5 agents: עו"ד מתמחה (CEO), פאראלגל (MM), עוזר אדמיניסטרטיבי (Worker), בודק חוזים (Worker)
   - Tool stack: Israeli legal databases (mock), Gmail RTL, חשבונית ירוקה, Google Drive
   - Scenarios: לקוח חדש, פתיחת תיק, הכנת חוזה, ייעוץ ראשוני

6. **Sector Preset #2: רואה חשבון** (deep) — כנ"ל

7. **Israeli Tools Pack v1** (5 tools):
   - **`gmail_hebrew`** — שליחה/קריאה של מייל בעברית RTL, mockBehavior עברי
   - **`google_calendar_he`** — חיפוש/יצירת אירועים בעברית
   - **`green_invoice_mock`** — חשבונית ירוקה מדומה, יצירת חשבונית/קבלה
   - **`monday_basic`** — קריאה/כתיבה ל-Monday.com (אם API key מוגדר)
   - **`israeli_phone_lookup`** — חיפוש בסיסי של מספר טלפון ישראלי, identification של חברה

### Quality

8. **Tests** לכל מתודולוגיה שמועברת:
   - Office Runner ritual — verify enforcement
   - Slice-from-plan — verify resolves to step.description
   - Cross-iteration gate — verify second tool fire blocked
   - Step-scoped criteria — verify filtering
9. **Integration test scenario:** "תכין לי 2 מסמכים — וורד עם רקע X ואקסל עם טבלת Y" — Maestro מתכנן, Workers מבצעים, **שני מסמכים שונים נוצרים בלי כפילות.** זה ה-test שכשל ב-prototype וכאן הוא צריך לעבור from day one.

---

## Process Steps (כל שלב מתבסס על הקודם)

### שלב 1 — Office Runner Worker Template

**Trigger:** Phase 2 done.
**Done when:** template רשום ב-Paperclip, agent שמקבל "צור Word" עובר 4 שלבים נראים בלוג.

- [ ] קריאה מחודשת של [office-runner-template.ts](src/content/agents/office-runner-template.ts) מה-prototype
- [ ] בניית מקבילה ב-Paperclip's agent profile format
- [ ] system prompt עם 4-step ritual בעברית
- [ ] שילוב ב-Paperclip — registration כ-template נוסף
- [ ] integration test: agent שמקבל "צור Word" → 4 שלבים נראים בלוג

### שלב 2 — Cross-Iteration Tool Gate

**Trigger:** שלב 1 done — יש לנו worker template חי לבדוק עליו.
**Done when:** ניסיון של 2nd tool fire (parallel או sequential) נחסם בפועל.

- [ ] בדיקה: האם Paperclip's executor כבר מטפל בזה? בדוק את הקוד שלהם
- [ ] אם לא — patch ב-fork:
  - מונה fires per-delegation
  - synthetic error לכל fire שני
- [ ] tests
- [ ] decision point: patch upstream PR או לשמור ב-fork בלבד

### שלב 3 — Slice-from-Plan

**Trigger:** שלבים 1-2 done.
**Done when:** sub-agent ל-step-N רואה את `step.description` של step-N כ-slice ראשי, integration scenario עובר.

- [ ] בדיקה: איך Paperclip בונה את ה-initial message ל-sub-agent
- [ ] אם משתמש ב-free-text → patch כך ש-step.description לוקח עדיפות
- [ ] tests
- [ ] integration scenario: 2-step plan, וידוא ששני sub-agents קיבלו slices שונים

### שלב 4 — Step-Scoped Criteria + Revision Retry

**Trigger:** שלב 3 done.
**Done when:** criteria עם `step_id` מסוננים ל-sub-agents הרלוונטיים בלבד; revision retry brief מוביל ב-feedback.

- [ ] port המבנה מ-prototype
- [ ] בדיקה: האם Paperclip's success criteria תומך ב-`step_id` tagging
- [ ] adjustment או patch
- [ ] revision retry brief — port מ-prototype

### שלב 5 — Sector Preset: משרד עו"ד

**Trigger:** שלבים 1-4 done — המתודולוגיה מוכנה לקבל תוכן עשיר.
**Done when:** בחירת preset ב-Wizard → company מלאה (5 agents + 30+ brain entries + tools + scenarios) נוצרת.

- [ ] עיצוב ה-brain schema — entities, relationships
- [ ] כתיבת 30+ brain entries בעברית עשירה
- [ ] עיצוב 4-5 agents (CEO + MM + 2-3 Workers) — soul, skills, tools, document
- [ ] חיבור ל-tools (gmail, calendar, חשבונית ירוקה)
- [ ] 3-4 scenarios שמדגים שימוש (לא בpetua hard-coded, אלא דוגמאות שה-CEO יכול לקרוא)
- [ ] integration: בחירת preset ב-Wizard → company נוצרת מלאה

### שלב 6 — Sector Preset: רואה חשבון

**Trigger:** שלב 5 done — הוכחנו שהמסלול עובד עם sector אחד.
**Done when:** preset שני זמין באותו רמת איכות.

- [ ] כנ"ל, content שונה

### שלב 7 — Israeli Tools Pack

**Trigger:** שלבים 1-4 done (לא תלוי בsector presets).
**Done when:** 5 כלים זמינים ועובדים עם 5-layer viz.

- [ ] בניית 5 הכלים — manifests, mock behaviors, brain bindings
- [ ] רישום ב-Paperclip's skill registry
- [ ] integration: agent שמקבל task → משתמש בכלי → התוצאה מופיעה ב-UI עם 5-layer viz

### שלב 8 — The Big Test + Tag

**Trigger:** כל השלבים הקודמים done.
**Done when:** integration test עובר, commit + push + tag.

- [ ] **THE Big Test:** "תכין לי 2 מסמכים — Word עם X ו-Excel עם Y" — verify שני מסמכים שונים, אין כפילות
- [ ] commit + push + tag `v0.1.0-feature-parity`

---

## Definition of Done

1. ✅ Office Runner Worker עם 4-step ritual רץ end-to-end
2. ✅ Cross-iteration tool gate חוסם בפועל ניסיון של 2nd fire
3. ✅ Slice-from-plan משתמש ב-step.description
4. ✅ Sector Preset של משרד עו"ד זמין ועובד — wizard → company → demo
5. ✅ Sector Preset של רואה חשבון זמין ועובד
6. ✅ 5 כלים ישראליים זמינים ועובדים עם 5-layer viz
7. ✅ The Big Test עובר: 2 מסמכים שונים נוצרים בלי כפילות
8. ✅ כל ה-tests עוברים
9. ✅ Commit + push + tag `v0.1.0-feature-parity`
10. ✅ Demo של 5 דקות מ-Company creation ל-2-document task

---

## פתוחות / החלטות שיוכרעו תוך כדי

- **Patch upstream או לשמור ב-fork?** — עבור כל patch ל-Paperclip core, נחליט case-by-case. patches קטנים עם שיפור איכותי — PR ל-upstream. patches שמשנים semantics — fork only
- **Sector presets רביעי וחמישי:** דחויים ל-Horizon 2 (Demo-Ready)
- **Tools pack #2 (חיבורים אמיתיים — לא mock):** דחוי ל-Horizon 2 (אחרי Plugin Host)
- **Office Visualization עומק — sprites אמיתיים:** דחוי ל-Phase 17 (לפי roadmap הישן, או שילוב של Metro City assets מ-pixel-agents)
- **AgentPromptBuilder dead fields (Phase 14 הישן):** ל-Phase 4 או 5, אחרי Demo-Ready

---

## אם תוך כדי גילינו ש...

- **Paperclip's executor מטפל ב-cross-iteration gate באופן שונה ותקין:** מסירים את ה-patch שלנו, סומכים על שלהם. עדכון `CLAUDE.md` עם הציון
- **המודלים של Hermes פחות מצייתים ל-system prompt מאשר Claude:** הריטואל של 4 צעדים אולי לא יחזיק שם. נצטרך adapter-specific prompt tweaks
- **Israeli tools (חשבונית ירוקה, מורנינג) דורשים auth flow מסובך:** ב-Phase 3 נשאיר mocks. אינטגרציה אמיתית ב-Horizon 3 (אחרי Plugin Host)
- **Brain seed של 30 entities עשיר מדי לכתוב באמת תוך 2 ימים:** מצמצמים ל-15 ומוסיפים בהמשך, או מאריכים את ה-Phase

---

## מה הולך אחרי Phase 3

סוף Horizon 1. הגענו ל-feature parity (ומעבר) עם ה-prototype. הולכים ל-Horizon 2 (Demo-Ready) — מתכננים Phases 4-5 בדפים נפרדים אחרי שמסיימים את Horizon הזה ו-לומדים מה למדנו.

**עיקרון:** לא לתכנן Phase 4 לפני שProm Phase 3 הסתיים. ב-end of Horizon 1 נעצור, נסכם learnings, נעדכן את `CLAUDE.md` ונבנה את ה-Phases הבאות.
