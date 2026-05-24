/**
 * Agent speech bubbles — transient Hebrew text shown above an agent's
 * head in the office canvas, reflecting what the agent is doing right
 * now in the chat/runtime layer.
 *
 * This module is pure data + helpers. It does NOT subscribe to events
 * or mutate office state; that's the job of `agentSpeechBridge.ts`.
 * Keeping it pure makes the phrase library easy to edit and test.
 *
 * The categories deliberately mirror the message-stream taxonomy used
 * by the chat panel (user dialog / agent reply / tool use / approval /
 * delegation / work product). One source of truth = no drift between
 * what the bubble says and what's actually happening.
 */

/** A discrete kind of activity that drives a bubble. */
export type SpeechCategory =
  | 'user_message_received'
  | 'agent_thinking'
  | 'agent_using_tool'
  | 'agent_replying'
  | 'approval_pending'
  | 'agent_delegated_down'
  | 'work_product_created'
  | 'idle_resting';

/** Per-category default lifetime (seconds). `null` = persistent until cleared. */
export const SPEECH_DURATION_SEC: Record<SpeechCategory, number | null> = {
  // Brief acknowledgement — the bridge fires this on `heartbeat.run.queued`
  // (the user just woke the agent) and lets the `running` event swap it
  // out for `agent_thinking` within ~half a second. Keep it short so a
  // stale "got it" line doesn't linger after thinking is well underway.
  user_message_received: 2.5,
  // "thinking" rolls — the bridge refreshes it as long as heartbeat
  // events keep arriving, so a short lifetime feels lively (the bubble
  // text rotates while the run is going).
  agent_thinking: 4,
  agent_using_tool: 6,
  agent_replying: 6,
  // Approvals stay up until the user acts. The bridge clears explicitly
  // when the approval entity flips out of `pending`.
  approval_pending: null,
  agent_delegated_down: 4,
  work_product_created: 7,
  idle_resting: 3,
};

/**
 * Priority for resolving simultaneous events (higher wins). When the
 * bridge wants to set a bubble, it compares against the currently
 * showing bubble's priority; lower-priority events are dropped so the
 * agent doesn't appear to "downgrade" what they're doing mid-action.
 */
export const SPEECH_PRIORITY: Record<SpeechCategory, number> = {
  approval_pending: 100,
  agent_using_tool: 80,
  agent_replying: 80,
  work_product_created: 80,
  agent_delegated_down: 80,
  user_message_received: 80,
  agent_thinking: 40,
  idle_resting: 10,
};

/**
 * Hebrew phrase libraries — picked at random per event to give the
 * office a "lived in" feel rather than scripted lines on loop.
 *
 * Editing rules:
 *  • Keep lines short (≤ 7 words) so they fit one bubble line.
 *  • Stay in first-person, present tense — the AGENT is speaking.
 *  • Avoid sector-specific jargon; the same agent serves any company.
 */
export const SPEECH_PHRASES: Record<SpeechCategory, readonly string[]> = {
  user_message_received: [
    'הבנתי, בודק, מיד חוזר אליך',
    'רגע, מסתכל על זה',
    'קלטתי — נותן בזה ראש',
    'אני על זה. שנייה אחת',
    'מבין מה אתה צריך, אוסף את המידע',
    ' בודק את העניין הזה ברגעים אלו',
  ],
  agent_thinking: [
    'מחבר את החתיכות...',
    'מתרכז במשימה',
    'מנתח את המצב',
    'מצליב כמה מקורות',
    'חושב על הדרך הכי טובה',
  ],
  agent_using_tool: [
    'מתחבר למערכת...',
    'מושך נתונים',
    'מבצע את הפעולה',
    'עוד רגע, באמצע פעולה',
    'מסיים את מה שהתחלתי',
  ],
  agent_replying: [
    'אוקיי, כתבתי לך תשובה בצ׳אט',
    'שלחתי לך תשובה, תעיף מבט',
    'סיימתי, התשובה ממתינה לך',
    'קפוץ לצ׳אט',
    'המידע אצלך, ראה הצ׳אט',
  ],
  approval_pending: [
    'ממתין לאישורך לפני שאמשיך',
    'עוצר כאן — דרוש אישור',
    'פעולה רגישה, מחכה לאור ירוק ממך',
    'סיימתי את ההכנה — אישור?',
  ],
  agent_delegated_down: [
    'העברתי לעובד שיטפל',
    'הקצאתי את המשימה הלאה',
    'הצוות עובד על זה',
    'ממתין לתוצאה מהצוות',
  ],
  work_product_created: [
    'התוצר מוכן — בצ׳אט',
    'צירפתי קובץ לסיכום',
    'סיימתי להפיק את המסמך',
    'הקובץ מוכן להורדה',
  ],
  idle_resting: [
    'מוכן לעבודה',
    'מחכה למשימה',
    'פנוי כרגע',
    'כאן, מאזין',
  ],
};

/**
 * Pick a phrase from `category`'s pool. `lastPhrase` (the line currently
 * showing on the same agent) is avoided when possible — so a rolling
 * bubble doesn't repeat the same string two ticks in a row.
 */
export function pickPhrase(
  category: SpeechCategory,
  lastPhrase?: string | null,
): string {
  const pool = SPEECH_PHRASES[category];
  if (pool.length === 0) return '';
  if (pool.length === 1) return pool[0];
  if (!lastPhrase) {
    return pool[Math.floor(Math.random() * pool.length)];
  }
  // One reroll to avoid the immediate repeat; if RNG still picks the
  // same line, just live with it (don't loop forever).
  let pick = pool[Math.floor(Math.random() * pool.length)];
  if (pick === lastPhrase) {
    pick = pool[Math.floor(Math.random() * pool.length)];
  }
  return pick;
}

/** Runtime shape carried on each Character. */
export interface SpeechBubble {
  category: SpeechCategory;
  phrase: string;
  /**
   * Wall-clock ms timestamp at which the bubble should disappear.
   * `null` = persistent (clear explicitly via `clearSpeechBubble`).
   */
  expiresAt: number | null;
}
