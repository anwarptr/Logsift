import { classifyIp, IP_KIND_LABELS, ipLookupUrl } from '../utils/ip';

/**
 * Next to a client IP: a "Look up" link for public addresses, or a tag explaining why there is
 * nothing to look up (private, loopback, ...). Nothing is sent anywhere unless the link is clicked.
 * `compact` renders only the link icon (lists); non-public addresses then render nothing.
 */
export function IpInfo({ ip, compact = false }: { ip: string; compact?: boolean }) {
  const kind = classifyIp(ip);
  if (kind === 'invalid') return null;
  if (kind !== 'public') return compact ? null : <span className="tag">{IP_KIND_LABELS[kind]}</span>;
  return (
    <a
      className={compact ? 'ip-link compact' : 'ip-link'}
      href={ipLookupUrl(ip)}
      target="_blank"
      rel="noopener noreferrer"
      title={`Look up ${ip} on ipinfo.io (country, owner). Opens a new tab.`}
      aria-label={`Look up ${ip} on ipinfo.io (opens in a new tab)`}
      onClick={(e) => e.stopPropagation()}
    >
      {compact ? '↗' : 'Look up ↗'}
    </a>
  );
}
