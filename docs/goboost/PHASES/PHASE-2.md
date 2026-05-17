# Phase 2 — Visual UI Layer (Parallel Coexisting Strategy)

**יעד:** ה-UI שמשתמש פוגש הוא **שלנו** — pixel-agents engine + Hebrew RTL shell + Wizards + הצגה דינמית של מה שקורה ב-Paperclip בזמן אמת.
**Trigger:** Phase 1 done (ARCHITECTURE-MAP + MIGRATION-FROM-PROTOTYPE in place, Paperclip running).

---

## Strategy Recap (decided during Phase 1)

ה-PHASE-2 הזה נכתב מחדש אחרי שגילינו את [pixel-agents](https://github.com/pablodelucca/pixel-agents) ואת היכולת לחיות עם שני UIs במקביל. החלטות מפתח:

1. **Parallel Coexistence, not Wrap vs Replace.** ה-Paperclip UI (`ui/`) ו-GoBoost UI (`ui-goboost/`) חיים בו-זמנית — `:3100` ו-`:3200`. שתיהן מדברות לאותו backend. ה-Classic UI נשאר כ-admin reference וכ-visual debug ground truth לאורך כל הפיתוח.
2. **Lazy strip של pixel-agents UI.** משאירים את הפיצ'רים שלהם כמו שהם בינתיים, רק מחביאים מה שבולט שגוי. נחתוך באופן ממוקד ב-iterations עתידיות.
3. **Real data, no more mocks.** ה-3 mock agents שב-`browserMock.ts` הם פיגום ל-Iteration 1 בלבד. ברגע ש-`paperclipApi.ts` עובד — מורידים אותם.
4. **WhatsApp chat panel** — feature חשוב, יבוא אחרי שיש dat0 אמיתי.
5. **🟢 Hierarchy-Derived Dynamic Layout** — IP ייחודי. החדרים ייגזרו מ-`agents.reportsTo` במקום מקובץ JSON סטטי. גדול יותר, יבוא אחרי ה-WhatsApp panel.

---

## Iterations (כל אחד = goal צר וברור)

### Iteration 2.0 — Scaffold (done)

**Trigger:** Phase 1 done.
**Done when:** `ui-goboost/` קיים, רץ על `:3200`, מציג את ה-pixel-agents engine + Hebrew RTL banner + 3 mock agents.

- [x] Fork pixel-agents `webview-ui/` + `shared/` → `goboost-platform/ui-goboost/`
- [x] Adjust vite.config (port 3200, local outDir, shared imports)
- [x] Hebrew RTL in `index.html`
- [x] Add to pnpm-workspace, root scripts (`dev:goboost`)
- [x] 3 mock agents in browserMock as engine proof
- [x] NOTICE.md + LICENSE-PIXEL-AGENTS for attribution
- [x] commit + push

### Iteration 2.A — Real Data (`paperclipApi.ts`) ⬅ הבא

**Trigger:** Iteration 2.0 done.
**Done when:** יוצרים Company + agents ב-Paperclip UI (`:3100`) → הדמויות מופיעות במשרד שלנו (`:3200`) באופן אוטומטי. ה-3 mocks מוסרים מ-browserMock.

- [ ] חקירת ה-API של Paperclip: אילו endpoints חושפים agents/companies/runs/issues/tool calls (`/api/companies`, `/api/agents`, `/api/heartbeat-runs`, `/api/issues`...)
- [ ] בדיקה: יש WebSocket/SSE לעדכונים בזמן אמת, או שמחזיקים polling?
- [ ] בניית `ui-goboost/src/paperclipApi.ts` — מודול שמתחבר ל-`http://localhost:3100/api/*`
- [ ] mapping table: Paperclip event → pixel-agents message
  - `agent created/listed` → `agentCreated` message
  - `agent status change` → `agentStatus` message
  - `heartbeat run started/finished` → `agentToolStart`/`agentToolDone` events
  - `agent paused` → `agentStatus: 'waiting'` or similar
- [ ] חיבור ב-`App.tsx`: אם `paperclipApi` זמין → תשתמש בו במקום `browserMock`. אם לא (אופציה fallback) → mocks
- [ ] Config: `import.meta.env.VITE_PAPERCLIP_API_URL` ברירת מחדל `http://localhost:3100/api`
- [ ] הסרת 3 ה-mock agents מ-browserMock (או החלפתם בהודעה "אין חיבור ל-Paperclip" + הפניה ל-:3100)
- [ ] תיעוד: README ב-`ui-goboost/src/paperclipApi.ts` עם ה-mapping המלא
- [ ] test scenario: יצירת Company בPaperclip → רואים agents בGoBoost UI

**Open questions לפני התחלה:**
- האם Paperclip מציע SSE/WebSocket או רק REST? צריך לחפש ב-`server/src/realtime/`
- מה ה-shape של `TranscriptEntry` events? נגלה תוך כדי כשנקרא את `heartbeat_run_events` API

### Iteration 2.B — WhatsApp Chat Panel

**Trigger:** Iteration 2.A done — יש agents חיים.
**Done when:** פאנל ימני קבוע עם chat thread של ה-agent שנבחר. שולחים הודעה → מופיעה ב-issue comments של ה-agent. הודעת תגובה של ה-agent מופיעה בפאנל אוטומטית.

- [ ] עיצוב UI: פאנל ימני קבוע (300-380px), bubbles בסגנון WhatsApp (ירוק=outgoing, אפור=incoming), avatar של ה-agent למעלה
- [ ] חיבור ל-`/api/issues/:id/comments` (Paperclip API)
- [ ] שליחה: `POST /api/issues/:id/comments` עם message מהמשתמש
- [ ] קבלה: subscribe לעדכוני comments בזמן אמת
- [ ] selection: כשבוחרים agent ב-office, ה-panel נטען עם ה-issue האחרון/הפעיל שלו
- [ ] תמיכה ב-attachments
- [ ] Hebrew RTL בכל ה-bubbles והפלייסהולדרים

### Iteration 2.C — Hierarchy-Derived Dynamic Layout (🟢 GoBoost IP)

**Trigger:** Iterations 2.A + 2.B done.
**Done when:** ה-layout של החדרים נוצר אוטומטית מ-`agents.reportsTo` של ה-company. כל "team" (manager + direct reports) = חדר משלו. החלפת company → החלפת layout.

- [ ] חקירה: `OfficeState` של pixel-agents מקבל layout מ-`layoutLoaded` event. הם משתמשים ב-static JSON. נצטרך להחליף את ה-loader
- [ ] בניית layout-generator: input = רשימת agents עם `reportsTo` → output = layout JSON שתואם ל-pixel-agents schema
- [ ] אלגוריתם: BFS על `reportsTo` tree → רמה 1 = חדר CEO, רמות עמוקות יותר = חדרים נוספים. רהיטים: 1 PC + שולחן לכל סוכן, ספה משותפת לכל חדר
- [ ] שיבוץ characters: כל agent יושב בחדר של ה-manager שלו (או בחדר CEO אם הוא בעצמו CEO)
- [ ] עדכון דינמי: אם hierarchy משתנה ב-Paperclip → layout מתעדכן
- [ ] אופציה לעריכה ידנית: גם ה-layout המקורי שלהם נשאר זמין כ-override

---

## Definition of Done — Phase 2 כולה

1. ✅ `ui-goboost` רץ ב-`:3200` עם Hebrew RTL (Iteration 2.0)
2. ⏳ Real-time chars מגיעים מ-Paperclip, אין יותר mocks (Iteration 2.A)
3. ⏳ WhatsApp chat panel פעיל ומחובר ל-issue comments (Iteration 2.B)
4. ⏳ Hierarchy-derived layout עובד דינמית (Iteration 2.C)
5. ⏳ commit נקי + push

## מה לא נכלל ב-Phase 2 (יחכה ל-Phase 3+)

- **Wizards (Company / Agent / Sector)** — ל-Phase 3 (Methodology Port)
- **Office Visualization sprites חדשים** — Phase 17 (per old roadmap)
- **Brain panel** — Phase 3-4
- **Inspection panels (agent editor, etc.)** — Phase 3
- **Sector presets ישראליים** — Phase 3
- **Israeli tools (Gmail RTL, חשבונית ירוקה, ...)** — Phase 3

## אם תוך כדי גילינו ש...

- **Paperclip לא חושף SSE/WebSocket** — Iteration 2.A יהיה polling-based, פחות אלגנטי אבל עובד
- **ה-comment system של Paperclip לא מתאים ל-chat real-time** — נדרש PATCH ל-fork או חידוש endpoint
- **Hierarchy-derived layout מורכב מאוד** — נדחה את Iteration 2.C ל-Phase 3, נשאיר את ה-layout הסטטי בינתיים

---

## מה הולך אחרי Phase 2

Phase 3 — Methodology Port + Israeli Content Pack (כפי שמוגדר ב-`docs/goboost/PHASES/PHASE-3.md`, אבל נעדכן את ה-Trigger כדי שיתחיל אחרי 2.C ולא אחרי 2.6).
