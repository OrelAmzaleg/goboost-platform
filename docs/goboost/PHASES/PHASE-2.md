# Phase 2 — UI Wrapper (Hebrew RTL + Visualization Base)

**יעד:** ה-UI שמשתמש פוגש הוא **שלנו**: בעברית, RTL מלא, עם תחילת ויזואליזציית המשרד, ועם wizards פשוטים להקמת company.
**Trigger:** Phase 1 done.

---

## ההחלטה הקריטית — Wrap vs. Replace

לפי מה שגילינו ב-Phase 1 (במסמך `ARCHITECTURE-MAP`), נחליט בין שתי גישות:

### גישה A — Wrap (אם ה-UI של Paperclip מודולרי)

- שומרים את ה-React UI שלהם לחלקים שעובדים well (admin, settings, low-level views)
- בונים שכבת UI שלנו לחלקים שהמשתמש פוגש (Dashboard, Wizards, Company View, Office Visualization)
- ה-Hebrew RTL מוחל גלובלית — גם על מה שנשאר משלהם וגם על שלנו
- חיסכון: לא בונים מהתחלה את כל ה-admin panel
- עלות: צריך להבטיח i18n שלהם תקין, ותפקוד RTL שלהם

### גישה B — Replace (אם ה-UI שלהם hardcoded ל-English או לא ידידותי ל-RTL)

- מחליפים לחלוטין את ה-React UI שלהם, משאירים רק את ה-backend
- ה-UI שלנו הוא single SPA חדש שמדבר עם ה-API של Paperclip
- חיסכון: שליטה מלאה, אסתטיקה אחידה, RTL מהיום הראשון
- עלות: צריך לבנות גם את ה-admin panel + settings + audit views

**ההחלטה נופלת אחרי Phase 1.** אם ה-UI שלהם משתמש ב-i18n library טוב — A. אם זה hardcoded — B.

---

## Deliverables (משותפים לשתי הגישות)

1. **Hebrew RTL Theme** — Tailwind config + CSS base שמטפל ב-RTL, fonts עבריים (Heebo / Rubik / Assistant), כיוון icons הפוך
2. **i18n Layer** — מערכת translations שמתאימה לעברית קודם, עם hooks ל-content מ-Paperclip שעוד בעברית
3. **Wizards פשוטים:**
   - Company Wizard — 4-6 שלבים: שם, סקטור, גודל, ערוצי תקשורת, agent ראשון, אישור
   - Agent Builder — 3-4 שלבים: role, soul, skills, tools
   - Sector Selector — בחירת preset מתוך 2-3 פרי-built (משרד עו"ד, רואי חשבון, חברת תוכנה — קל יותר ב-Phase זה, sectors עמוקים יותר ב-Phase 3)
4. **Office Visualization v0** — Phaser scene בסיסי, חדר אחד, 1-2 דמויות, breathing animation, אנימציה כאשר agent פעיל
5. **5-Layer Tool Visualization Bridge** (פורט מ-prototype) — אם adapter קורא לכלי, נדלקים: chat pill + badge + action icon + bubble narration + side panel
6. **Hebrew Error Handling** — כל error message בעברית, לא stack traces ל-UI

---

## Process Steps (כל שלב מתבסס על הקודם)

### שלב 1 — UI Foundation

**Trigger:** ההחלטה wrap vs replace נופלת (מבוסס על ARCHITECTURE-MAP מ-Phase 1).
**Done when:** Tailwind+RTL מותקנים, font עברי מוטמע, layout בסיסי שלנו עובד.

- [ ] התקנת Tailwind + RTL plugin (`tailwindcss-rtl`)
- [ ] הגדרת Heebo font ב-`index.html` + Tailwind config
- [ ] גלובלי `<html dir="rtl" lang="he">` — וידוא שזה תקף גם בעמודים של Paperclip
- [ ] בדיקת אינטגרציה: עמוד admin של Paperclip ב-RTL — מה נשבר? תיעוד
- [ ] (אם גישה A) — בניית wrapper layout שמכיל את ה-UI שלהם + הוספת sidebar/topbar שלנו
- [ ] (אם גישה B) — יצירת SPA חדש ב-`apps/goboost-ui/` שמדבר עם API של Paperclip

### שלב 2 — i18n + Translations

**Trigger:** שלב 1 done — RTL foundation עובד.
**Done when:** מסך הראשי כולו בעברית, אין מילה באנגלית בעין.

- [ ] בחירת i18n library (`react-i18next` מומלץ — תקן בתעשייה)
- [ ] קונפיגורציה: עברית primary, English fallback
- [ ] תרגום של ה-strings הכי נראים: navigation, common buttons, statuses, dialogs
- [ ] (אם גישה A) — patch ל-Paperclip strings שאי-אפשר לתרגם דרך i18n שלהם
- [ ] testing — מסך הראשי כולו בעברית

### שלב 3 — Wizards

**Trigger:** שלבים 1-2 done — יש לנו UI עברי תקין לבנות עליו.
**Done when:** Company Wizard + Agent Builder + Sector Selector עובדים end-to-end.

- [ ] עיצוב flow של Company Wizard — 4-6 שלבים, navigation, validation, progress bar
- [ ] בניית Company Wizard component — 6 שלבים סודרים, state בנפרד מ-Paperclip data model
- [ ] על completion — קריאה ל-API של Paperclip ליצירת Company + Agents
- [ ] Agent Builder — דומה אבל קצר יותר (3-4 שלבים)
- [ ] Sector Selector — 2-3 קוביות מאוירות, בחירה → טעינת preset

### שלב 4 — Office Visualization v0

**Trigger:** שלב 1 done (אפשר במקביל לשלבים 2-3).
**Done when:** Phaser scene נטען, דמויות נושמות, חיבור ראשוני ל-state של Paperclip עובד.

- [ ] התקנת Phaser ב-frontend
- [ ] React-Phaser bridge — div container + useEffect
- [ ] Scene בסיסי — חדר יחיד, רקע פשוט, רצפה
- [ ] CharacterRenderer — 1-2 דמויות בסיסיות (placeholder, port מ-prototype)
- [ ] Breathing animation — תמיד רצה, גם כשאין activity
- [ ] חיבור ל-state של Paperclip — כשagent רץ task, דמותו זזה
- [ ] (port מ-prototype — `src/engine/rendering/`)

### שלב 5 — 5-Layer Tool Visualization Bridge

**Trigger:** שלבים 3+4 done — יש wizards פעילים ויש Phaser scene עם דמויות.
**Done when:** כל 5 השכבות נדלקות אוטומטית מנקודה אחת כשadapter קורא לכלי.

זה ה-IP החזק שלנו. פורט מהקוד הקיים [src/services/agents/AgentVisualBridge.ts](src/services/agents/AgentVisualBridge.ts) ו-helpers.

- [ ] חיבור ל-event stream של Paperclip — מתי adapter מתחיל tool call, מתי מסיים
- [ ] Layer 1 — chat pill ב-WhatsApp UI ("דנה משתמשת ב-CRM...")
- [ ] Layer 2 — badge על דמות הסוכן ב-Office Visualization
- [ ] Layer 3 — action icon מעל החדר שלו
- [ ] Layer 4 — bubble narration (דנה אומרת "אני בודקת...")
- [ ] Layer 5 — side panel update ("דנה: השתמשה ב-CRM, החזירה 3 רשומות")
- [ ] all 5 layers מתעוררות מנקודה אחת — `bridge.markToolStart()` / `bridge.markToolEnd()`

### שלב 6 — Stabilize

**Trigger:** שלבים 1-5 done.
**Done when:** Phase 2 Definition of Done מתקיים, commit נקי + push.

- [ ] תיקון bugs מהשלבים הקודמים
- [ ] בדיקה רוחבית של ה-UI — וידוא שהכל RTL, אין מילה לא מתורגמת בעין
- [ ] עדכון `CLAUDE.md` עם learnings חדשים אם יש
- [ ] commit נקי + push

---

## Definition of Done

1. ✅ המשתמש פותח את ה-platform → רואה עברית מלאה, RTL מלא
2. ✅ Wizard של Company עובד end-to-end (6 שלבים → company נוצרת)
3. ✅ Wizard של Agent עובד end-to-end
4. ✅ 1-2 sector presets זמינים לבחירה
5. ✅ Office Visualization נטען עם 1-2 דמויות שנושמות
6. ✅ כשAgent רץ task — 5 השכבות נדלקות
7. ✅ אין error message ב-UI באנגלית
8. ✅ commit נקי

---

## פתוחות / החלטות שיוכרעו תוך כדי

- **Routing:** האם משתמשים ב-routing של Paperclip או בונים שלנו?
- **State management:** Zustand (כמו prototype) או redux/jotai לפי מה שPaperclip משתמש?
- **Authentication:** Paperclip ודאי כבר יש להם — נשאיר את שלהם, רק נתרגם
- **Mobile responsive:** דחיינו ל-Phase 4. בדמואים אנחנו על desktop
- **Color scheme:** GoBoost branding — צריך אצלך החלטה. Default יהיה משהו נייטרלי בינתיים

---

## אם תוך כדי גילינו ש...

- **Paperclip UI עמוק יותר ממה שחשבנו (admin עם 20+ דפים):** גישה A. נעטוף בלי לגעת.
- **Wizards דורשים שינוי במודל של Paperclip (למשל אין concept של "sector preset"):** נוסיף שכבת preset שלנו לפני הקריאה ל-API שלהם — שכבה ב-GoBoost layer
- **Phaser דורש refactor של React-Phaser bridge בגלל Paperclip stack:** נדחה את ה-Office Visualization ל-Phase 4 ונשקיע יותר ב-UI הטקסטואלי

---

## מה הולך אחרי Phase 2

Phase 3 — Methodology Port. אחרי שיש לנו UI חזק וויזואלי, מעבירים את ה-content והמתודולוגיות שלנו: 4-step ritual של office-runner, slice-from-plan, sector presets עמוקים יותר, ה-Israeli tools pack הראשון.
