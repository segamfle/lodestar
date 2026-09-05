import { useEffect, useState } from 'react';
import {
  connectGameToHost,
  observeGameContentSize,
  type GuestApiV1,
  type HostApiV1,
  type HostSnapshotV1,
} from '@chain/casino-sdk/guest';

/**
 * Is there any chance of a host? If this page is the top window, there is nothing to shake
 * hands with and no amount of waiting will change that.
 *
 * A first version decided this with a timer and got it wrong intermittently: under React's
 * development double-mount the race sometimes resolved the other way and the game sat behind
 * "waiting for the host wallet" forever, on a page that was never going to have one. The
 * frame relationship is knowable synchronously, so it should be known synchronously.
 *
 * Cross-origin access to `window.top` can throw, and a throw means we are framed by someone
 * else - which is exactly the case where a host might be listening.
 */
function couldBeFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Guest side of the casino bridge.
 *
 * The host owns the wallet and does all the signing; this game never touches either. It
 * connects on mount, mirrors every snapshot the host pushes into React state, and reports its
 * content height back so the host can size the iframe.
 *
 * Running with no host is a supported state, not an error: the jam requires the page to work
 * when opened directly, and the standalone demo depends on that path being clean.
 */
export function useCasinoHost(): {
  hostApi: HostApiV1 | null;
  snapshot: HostSnapshotV1 | null;
  standalone: boolean;
} {
  const [hostApi, setHostApi] = useState<HostApiV1 | null>(null);
  const [snapshot, setSnapshot] = useState<HostSnapshotV1 | null>(null);
  const [standalone, setStandalone] = useState(() => !couldBeFramed());

  useEffect(() => {
    if (!couldBeFramed()) return; // top window: nothing to connect to
    let mounted = true;

    const guestMethods: GuestApiV1 = {
      async setState(nextSnapshot) {
        if (mounted) setSnapshot(nextSnapshot);
      },
    };

    const connection = connectGameToHost(guestMethods);

    // Framed, but nobody answered. Some embedder that is not the casino host, so fall
    // through to the playable demo rather than leaving a spinner up forever.
    const giveUp = setTimeout(() => {
      if (mounted) setStandalone((current) => current || true);
    }, 2000);

    void connection.promise
      .then((parent) => {
        if (!mounted) return;
        clearTimeout(giveUp);
        setHostApi(parent);
        setStandalone(false);
      })
      .catch(() => {
        if (mounted) setStandalone(true);
      });

    return () => {
      mounted = false;
      clearTimeout(giveUp);
      connection.destroy();
    };
  }, []);

  useEffect(() => {
    if (!hostApi) return;
    const observer = observeGameContentSize(hostApi);
    return () => observer.disconnect();
  }, [hostApi]);

  return { hostApi, snapshot, standalone };
}
