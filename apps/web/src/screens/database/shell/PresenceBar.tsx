import { useLingui } from '@lingui/react/macro';
import type { PresencePeer } from '@riosoma/contracts';
import { AvatarStack } from '@riosoma/ui';
import './shell.css';

export function PresenceBar({ peers }: { peers: readonly PresencePeer[] }) {
  const { t } = useLingui();
  const people = [
    ...new Map(
      peers.map((peer) => [peer.userId, { id: peer.userId, name: peer.name, color: peer.color }]),
    ).values(),
  ];
  return (
    <div
      className="rio-db-presence"
      role="group"
      aria-label={t({ id: 'database.presence.label', message: 'People here' })}
    >
      <AvatarStack people={people} max={people.length} size="sm" />
    </div>
  );
}
