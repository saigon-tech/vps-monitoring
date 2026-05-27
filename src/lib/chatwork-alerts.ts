import { env } from './env';
import { formatBytes, percent } from './utils';
import { chatworkSendMessage } from './chatwork-client';

export function isChatworkConfigured(): boolean {
  return Boolean(env.CHATWORK_API_KEY && env.CHATWORK_ROOM_ID);
}

export type HeartbeatForAlert = {
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
};

export type AgentDisconnectReason = 'offline' | 'shutdown';

export type AgentForAlert = {
  agentId: string;
  hostname: string;
  label?: string | null;
  publicIp?: string | null;
  lastChatworkAlertAt?: Date | string | null;
};

export type AgentForDisconnectAlert = {
  agentId: string;
  hostname: string;
  label?: string | null;
  publicIp?: string | null;
  lastSeenAt?: Date | string | null;
  lastChatworkOfflineAlertAt?: Date | string | null;
};

function displayName(agent: { label?: string | null; hostname: string; agentId: string }): string {
  return (agent.label?.trim() || agent.hostname || agent.agentId).slice(0, 200);
}

export async function sendChatworkOverloadIfNeeded(
  agent: AgentForAlert,
  m: HeartbeatForAlert,
  thresholds: { cpu: number; ram: number; disk: number },
  cooldownMs: number,
  appUrl: string
): Promise<boolean> {
  if (!isChatworkConfigured()) return false;

  const ramPct = percent(m.memUsedBytes, m.memTotalBytes);
  const diskPct = percent(m.diskUsedBytes, m.diskTotalBytes);
  const cpuHigh = m.cpuPercent >= thresholds.cpu;
  const ramHigh = ramPct >= thresholds.ram;
  const diskHigh = diskPct >= thresholds.disk;
  if (!cpuHigh && !ramHigh && !diskHigh) return false;

  const last = agent.lastChatworkAlertAt ? new Date(agent.lastChatworkAlertAt).getTime() : 0;
  if (last && Date.now() - last < cooldownMs) return false;

  const name = displayName(agent);
  const lines: string[] = [
    '[info][title]VPS Monitor — tài nguyên vượt ngưỡng[/title]',
    `Máy: ${name}`,
    `Agent: ${agent.agentId}`,
  ];
  if (agent.publicIp) lines.push(`IP: ${agent.publicIp}`);
  if (cpuHigh) lines.push(`CPU: ${m.cpuPercent.toFixed(1)}% (≥ ${thresholds.cpu}%)`);
  if (ramHigh) {
    lines.push(
      `RAM: ${ramPct.toFixed(1)}% — ${formatBytes(m.memUsedBytes)} / ${formatBytes(m.memTotalBytes)} (≥ ${thresholds.ram}%)`
    );
  }
  if (diskHigh) {
    lines.push(
      `Ổ đĩa (/): ${diskPct.toFixed(1)}% — ${formatBytes(m.diskUsedBytes)} / ${formatBytes(m.diskTotalBytes)} (≥ ${thresholds.disk}%)`
    );
  }

  const base = appUrl.replace(/\/$/, '');
  lines.push(`Chi tiết: ${base}/servers/${encodeURIComponent(agent.agentId)}`);
  lines.push('[/info]');

  const result = await chatworkSendMessage(env.CHATWORK_API_KEY, env.CHATWORK_ROOM_ID, lines.join('\n'));
  if (!result.ok) {
    console.error('[chatwork] sendMessage failed:', result.httpStatus, result.description);
    return false;
  }
  return true;
}

export async function sendChatworkDisconnectIfNeeded(
  agent: AgentForDisconnectAlert,
  appUrl: string,
  reason: AgentDisconnectReason
): Promise<boolean> {
  if (!isChatworkConfigured()) return false;

  if (!agent.lastSeenAt) return false;
  const lastSeen = new Date(agent.lastSeenAt).getTime();
  if (!Number.isFinite(lastSeen)) return false;
  const lastAlert = agent.lastChatworkOfflineAlertAt
    ? new Date(agent.lastChatworkOfflineAlertAt).getTime()
    : 0;
  if (lastAlert && lastAlert >= lastSeen) return false;

  const name = displayName(agent);
  const title =
    reason === 'shutdown'
      ? 'VPS Monitor — agent dừng/shutdown'
      : 'VPS Monitor — VPS mất kết nối';
  const lines: string[] = [
    `[info][title]${title}[/title]`,
    `Máy: ${name}`,
    `Agent: ${agent.agentId}`,
  ];
  if (agent.publicIp) lines.push(`IP: ${agent.publicIp}`);
  if (agent.lastSeenAt) lines.push(`Lần cuối heartbeat: ${new Date(agent.lastSeenAt).toISOString()}`);
  lines.push(
    reason === 'shutdown'
      ? 'Agent gửi tín hiệu dừng. Có thể VPS đang shutdown/reboot hoặc service bị stop.'
      : 'Dashboard không nhận heartbeat. Kiểm tra VPS, mạng hoặc service agent.'
  );
  const base = appUrl.replace(/\/$/, '');
  lines.push(`Chi tiết: ${base}/servers/${encodeURIComponent(agent.agentId)}`);
  lines.push('[/info]');

  const result = await chatworkSendMessage(env.CHATWORK_API_KEY, env.CHATWORK_ROOM_ID, lines.join('\n'));
  if (!result.ok) {
    console.error('[chatwork] sendMessage failed:', result.httpStatus, result.description);
    return false;
  }
  return true;
}

export async function sendChatworkTestMessage(): Promise<{ ok: boolean; error?: string }> {
  if (!isChatworkConfigured()) {
    return { ok: false, error: 'Chưa cấu hình CHATWORK_API_KEY + CHATWORK_ROOM_ID trong .env.' };
  }
  const result = await chatworkSendMessage(
    env.CHATWORK_API_KEY,
    env.CHATWORK_ROOM_ID,
    '[info][title]VPS Monitor[/title]Thử nghiệm — nếu bạn thấy tin này, Chatwork đã được cấu hình đúng.[/info]'
  );
  if (!result.ok) {
    return { ok: false, error: result.description };
  }
  return { ok: true };
}
