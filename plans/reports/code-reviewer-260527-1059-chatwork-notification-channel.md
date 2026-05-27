# Code Review: Chatwork Notification Channel Integration

## Scope
- **Files:** `chatwork-client.ts`, `chatwork-alerts.ts`, `env.ts`, `heartbeat/route.ts`, `agents/route.ts`, `agents/[agentId]/route.ts`, `alerts/test/route.ts`, `SettingsClient.tsx`, `settings/page.tsx`
- **LOC:** ~230 new/modified lines across 9 files
- **Focus:** Correctness, security, error handling, consistency with Telegram patterns

## Overall Assessment

The Chatwork integration follows the existing Telegram pattern reasonably well. The low-level client (`chatwork-client.ts`) is clean with proper error handling, timeout, and no API key leaks. However, there are **several bugs and one design concern** related to cooldown tracking that will cause incorrect behavior in production.

---

## Critical Issues

### 1. Chatwork reuses Telegram's cooldown tracking fields (BUG -- dual-channel alert storms)

**Files:** `chatwork-alerts.ts`, `heartbeat/route.ts`, `agents/route.ts`, `agents/[agentId]/route.ts`

Chatwork overload and disconnect alerts read from `agent.lastTelegramAlertAt` and `agent.lastTelegramOfflineAlertAt` for cooldown gating, but these fields are only written when Telegram successfully sends. This creates two failure modes:

- **If Telegram is NOT configured but Chatwork IS:** The Chatwork overload alert reads `lastTelegramAlertAt` which is never set by Chatwork, so it defaults to `0` / no cooldown. Chatwork will fire on **every single heartbeat** that exceeds threshold with zero cooldown protection. Alert storm.
- **If both are configured:** Telegram sets `lastTelegramAlertAt` after a successful send. Chatwork reads it and sees the cooldown is satisfied, so it also sends. This works by accident for the "first send" case, but if Telegram's alert succeeds and Chatwork's fails, subsequent heartbeats will skip Chatwork too (cooldown already set by Telegram).

Same problem applies to `lastTelegramOfflineAlertAt` for disconnect alerts.

In `heartbeat/route.ts:157-179`, the Chatwork overload call passes `appSettings.telegramCooldownSeconds * 1000` as the cooldown. There is no `chatworkCooldownSeconds` -- the Telegram cooldown value is borrowed. This is fragile.

**Impact:** Alert spam through Chatwork when Telegram is not configured. Missing Chatwork alerts when Telegram is configured.

**Fix:** Add `lastChatworkAlertAt` and `lastChatworkOfflineAlertAt` fields to the Agent model. Update Chatwork functions to use their own tracking fields. Persist them on successful Chatwork send, the same way Telegram does.

### 2. Chatwork disconnect alerts in GET endpoints bypass cooldown persistence

**Files:** `agents/route.ts:108`, `agents/[agentId]/route.ts:46`

Both `GET /api/agents` and `GET /api/agents/[agentId]` call `sendChatworkDisconnectIfNeeded` but **never persist** any cooldown timestamp back to the agent document. Compare with Telegram in the same endpoints, which calls `Agent.updateOne({ $set: { lastTelegramOfflineAlertAt } })`.

Even if you add `lastChatworkOfflineAlertAt` per issue 1, these call sites do not persist it, so the disconnect alert will fire on every GET request until the agent comes back online.

**Fix:** After the `sendChatworkDisconnectIfNeeded` call, check the return value and persist `lastChatworkOfflineAlertAt` similar to the Telegram pattern.

---

## High Priority

### 3. `sendChatworkDisconnectIfNeeded` in `heartbeat/route.ts` ignores return value

**File:** `heartbeat/route.ts:88-99`

The return value of `sendChatworkDisconnectIfNeeded` is `await`ed but not captured. The Telegram equivalent captures `sent` and uses it to set `agent.lastTelegramOfflineAlertAt`. Even with separate Chatwork tracking fields, this call site needs to persist the result.

### 4. `sendChatworkOverloadIfNeeded` in `heartbeat/route.ts` ignores return value

**File:** `heartbeat/route.ts:157-179`

Same pattern -- the return value is discarded. When separate Chatwork fields are added, this needs to persist `lastChatworkAlertAt` on the agent document.

### 5. No Chatwork cooldown configuration

The Chatwork channel uses `appSettings.telegramCooldownSeconds` as its cooldown value. There is no separate Chatwork cooldown setting in the UI or in the app settings model. This means operators cannot tune Chatwork alert frequency independently from Telegram.

If separate tracking fields are introduced (per issue 1), this becomes a config gap. If shared cooldown is intentional, document it clearly.

### 6. Type names in `chatwork-alerts.ts` reuse Telegram field names

**File:** `chatwork-alerts.ts:24, 33`

`AgentForAlert.lastTelegramAlertAt` and `AgentForDisconnectAlert.lastTelegramOfflineAlertAt` appear in Chatwork-specific type definitions. This is misleading -- a developer reading the Chatwork module would not expect Telegram fields here. Rename to something channel-agnostic (e.g., `lastAlertAt`, `lastOfflineAlertAt`) or add Chatwork-specific fields.

---

## Medium Priority

### 7. `isChatworkConfigured()` evaluated at render time in Server Component

**File:** `settings/page.tsx:12`

`isChatworkConfigured()` reads `process.env` via the `env` module. In a Next.js Server Component, this is fine for production (env is available at request time). However, since `env.CHATWORK_API_KEY` and `env.CHATWORK_ROOM_ID` are getter properties that return `process.env.X ?? ''`, they will return empty strings during static generation or build time if the env vars are not set. The `dynamic = 'force-dynamic'` directive protects against this. This is acceptable but worth noting.

### 8. `chatwork-client.ts` JSON parse fallback silently swallows errors

**File:** `chatwork-client.ts:34`

```typescript
const data = (await res.json().catch(() => ({}))) as { ... };
```

If the Chatwork API returns a non-JSON error body (HTML error page, empty body), the fallback `({})` means `data.errors` will be undefined and the error description will be a generic `HTTP {status}`. This matches the Telegram client pattern so it is consistent, but worth noting that Chatwork API errors may provide useful diagnostics that get lost.

### 9. No rate limit protection on test endpoint

**File:** `alerts/test/route.ts`

The `?channel=chatwork` branch calls the Chatwork API directly with no rate limiting. An authenticated admin could spam the test button and trigger Chatwork API rate limits. This is low risk since it requires auth, but the Telegram branch has the same issue so it is consistent.

---

## Low Priority

### 10. Missing `botToken` input field population for Telegram

Not a Chatwork issue, but the Telegram form initializes `botToken` state to `''` and only populates `chatId` from `alertData`. The `alertData.botTokenConfigured` boolean is used for display, but the actual token value is never sent back to the client (correct security practice). No issue here, just noting the consistency.

### 11. Chatwork status card has no editable fields

The Chatwork status card in `SettingsClient.tsx` is display-only (status + test button). Since configuration is via `.env` only, this is correct by design. Just calling it out as a deliberate difference from the Telegram form.

---

## Positive Observations

1. **Clean client abstraction:** `chatwork-client.ts` is well-structured with proper timeout (15s), error typing, and no key leaks in responses.
2. **Chatwork API key sent via header, not query string:** Uses `X-ChatworkToken` header correctly. No risk of key leaking into server logs.
3. **Test endpoint requires authentication:** `getSessionFromCookies()` check prevents unauthorized test message abuse.
4. **No API key in client bundle:** `isChatworkConfigured()` is only called in the Server Component (`page.tsx`), never in the client component. The boolean is passed as a prop. Good boundary.
5. **Consistent error logging:** `[chatwork]` prefix on console.error matches `[telegram]` pattern.
6. **Input validation in client:** Empty key/room check before making the API call. Proper URL encoding of room ID.
7. **`.env` is in `.gitignore`:** Verified that `.env` files are excluded from version control.

---

## Recommended Actions

1. **[Blocking]** Add `lastChatworkAlertAt` and `lastChatworkOfflineAlertAt` to the Agent schema (`src/lib/models/Agent.ts`). Update `chatwork-alerts.ts` types and logic to use these fields. Update all four call sites (`heartbeat`, `agents GET`, `agents/[agentId] GET`) to persist the Chatwork-specific timestamps on successful send. This prevents alert storms and is the highest-priority fix.
2. **[Blocking]** In `agents/route.ts:108` and `agents/[agentId]/route.ts:46`, capture the return value of `sendChatworkDisconnectIfNeeded` and persist the offline alert timestamp.
3. **[Recommended]** Consider adding a `chatworkCooldownSeconds` app setting, or at minimum rename `telegramCooldownSeconds` to `alertCooldownSeconds` to reflect shared usage.
4. **[Recommended]** Rename the Telegram-specific field names in `chatwork-alerts.ts` type definitions to avoid confusion.

## Metrics
- Type Coverage: Good (explicit return types, Zod validation on inputs)
- Test Coverage: No tests found for Chatwork integration (no test files in diff)
- Linting Issues: Not run (no lint config found in diff)

## Unresolved Questions
1. Should Chatwork have its own cooldown configuration, or is sharing the Telegram cooldown acceptable?
2. Should the Agent schema migration include backfill for existing documents (setting new Chatwork fields to null)?
3. Are there plans to add unit/integration tests for the Chatwork alert logic?
