import { useEffect } from 'react';
import { useLogStore } from '../store/logStore';
import { parseFilters, serializeFilters } from './urlState';

/** Keep the filter state mirrored in location.hash so a view can be shared by URL. */
export function useUrlSync(): void {
  const filters = useLogStore((s) => s.filters);
  const replaceFilters = useLogStore((s) => s.replaceFilters);

  useEffect(() => {
    const hash = serializeFilters(filters);
    if (hash === location.hash || (hash === '' && location.hash === '')) return;
    history.replaceState(null, '', hash || location.pathname + location.search);
  }, [filters]);

  useEffect(() => {
    const onHash = () => {
      const current = serializeFilters(useLogStore.getState().filters);
      if (location.hash !== current) replaceFilters(parseFilters(location.hash));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [replaceFilters]);
}
