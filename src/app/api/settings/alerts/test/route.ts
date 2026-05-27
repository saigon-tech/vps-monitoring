import { NextResponse } from 'next/server';
import { getAppSettings } from '@/lib/app-settings';
import { getSessionFromCookies } from '@/lib/auth';
import { isTelegramAlertsConfigured, sendTelegramSettingsTestResult } from '@/lib/telegram-alerts';
import { sendChatworkTestMessage } from '@/lib/chatwork-alerts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const session = await getSessionFromCookies();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const channel = url.searchParams.get('channel') ?? 'telegram';

  try {
    if (channel === 'chatwork') {
      const r = await sendChatworkTestMessage();
      if (!r.ok) {
        return NextResponse.json({ error: r.error }, { status: 502 });
      }
      return NextResponse.json({ ok: true });
    }

    // default: telegram
    const settings = await getAppSettings();
    if (!isTelegramAlertsConfigured(settings)) {
      return NextResponse.json(
        { error: 'Chưa có bot token và chat id. Lưu cấu hình trước khi gửi thử.' },
        { status: 400 }
      );
    }
    const r = await sendTelegramSettingsTestResult(settings);
    if (!r.ok) {
      return NextResponse.json({ error: r.description, httpStatus: r.httpStatus }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[settings/alerts/test]', e);
    return NextResponse.json({ error: 'Gửi thử thất bại' }, { status: 500 });
  }
}
