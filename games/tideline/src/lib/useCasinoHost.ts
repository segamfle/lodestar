import { useEffect, useState } from 'react';
import {
  connectGameToHost,
  observeGameContentSize,
  type GuestApiV1,
  type HostApiV1,
  type HostSnapshotV1,
} from '@chain/casino-sdk/guest';

/**
 * Guest side of the casino bridge.
 *
 * The host owns the wallet and does all the signing; this game never touches either. It
 * connects on mount, mirrors every snapshot the host pushes into React state, and reports
 * its content height back so the host can size the iframe.
 *
 * The handshake never resolving is a normal state, not an error: opening the page directly
 * rather than inside the host is exactly what the jam requires it to survive, and the
 * standalone demo path depends on this failing quietly.
 */
export function useCasinoHost(): {
  hostApi: HostApiV1 | null;
  snapshot: HostSnapshotV1 | null;
  standalone: boolean;
} {
  const [hostApi, setHostApi] = useState<HostApiV1 | null>(null);
  const [snapshot, setSnapshot] = useState<HostSnapshotV1 | null>(null);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    let mounted = true;

    const guestMethods: GuestApiV1 = {
      async setState(nextSnapshot) {
        if (mounted) setSnapshot(nextSnapshot);
      },
    };

    const connection = connectGameToHost(guestMethods);

    // If no host answers shortly, we are being opened directly. Fall through to the
    // playable demo rather than leaving a spinner up forever.
    const solo = setTimeout(() => {
      if (mounted && !hostApi) setStandalone(true);
    }, 1200);

    void connection.promise
      .then((parent) => {
        if (!mounted) return;
        clearTimeout(solo);
        setHostApi(parent);
        setStandalone(false);
      })
      .catch(() => {
        if (mounted) setStandalone(true);
      });

    return () => {
      mounted = false;
      clearTimeout(solo);
      connection.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hostApi) return;
    const observer = observeGameContentSize(hostApi);
    return () => observer.disconnect();
  }, [hostApi]);

  return { hostApi, snapshot, standalone };
}
