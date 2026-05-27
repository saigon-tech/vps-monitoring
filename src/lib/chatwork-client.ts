/**
 * Low-level Chatwork API helpers (sendMessage).
 */

const CW = 'https://api.chatwork.com/v2';

export type ChatworkCallOk = { ok: true; messageId?: number };
export type ChatworkCallError = { ok: false; httpStatus: number; description: string };

export async function chatworkSendMessage(
  apiToken: string,
  roomId: string,
  message: string
): Promise<ChatworkCallOk | ChatworkCallError> {
  const token = apiToken.trim();
  const room = roomId.trim();
  if (!token) {
    return { ok: false, httpStatus: 400, description: 'Chatwork API key trống.' };
  }
  if (!room) {
    return { ok: false, httpStatus: 400, description: 'Chatwork Room ID trống.' };
  }
  const url = `${CW}/rooms/${encodeURIComponent(room)}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-ChatWorkToken': token,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `body=${encodeURIComponent(message)}`,
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      message_id?: number;
      errors?: { message?: string }[];
    };
    if (res.ok) {
      return { ok: true, messageId: data.message_id };
    }
    const desc =
      data.errors?.[0]?.message ??
      (res.status === 401
        ? 'HTTP 401 — API key không hợp lệ.'
        : res.status === 404
          ? 'HTTP 404 — Room ID không tồn tại.'
          : `HTTP ${res.status}`);
    return { ok: false, httpStatus: res.status, description: desc };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, httpStatus: 0, description: `Lỗi mạng: ${msg}` };
  }
}
