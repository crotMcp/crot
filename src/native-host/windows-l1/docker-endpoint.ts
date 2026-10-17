/** Native LOCAL transport for the shared AD-20.9 Docker policy. */
import type { AppContainerProfile } from "./appcontainer-profile.js";
import { assertOwnedAppContainerProfile } from "./appcontainer-profile.js";
import { loadBytePipeApi } from "./byte-stdio.js";
import { DockerEndpoint, type DockerEndpointOptions } from "../linux-l1/docker-endpoint.js";
import { createWindowsDockerBoundary, type WindowsDockerPaths } from "./docker-paths.js";
export async function openWindowsDockerEndpoint(options: {
  readonly profile: AppContainerProfile;
  readonly ownerSid: string;
  readonly paths: Omit<WindowsDockerPaths, "endpointSocket">;
  readonly upstream: DockerEndpointOptions["upstream"];
  readonly onRefusal: DockerEndpointOptions["onRefusal"];
  /** A transport failure disables the owning backend, never bypasses the proxy. */
  readonly failed: (error: Error) => void;
}): Promise<{ endpoint: DockerEndpoint; dockerHost: string }> {
  assertOwnedAppContainerProfile(options.profile);
  const api = await loadBytePipeApi();
  if (!api.listenLocal) throw new Error("Native LOCAL pipe transport is unavailable.");
  // Allocate the namespace before constructing the boundary: the exact native
  // address, not a guessed/caller-selected path, is the only mediated endpoint.
  let accept: Parameters<NonNullable<typeof api.listenLocal>>[0]["accept"] = (stream) => {
    stream.destroy(new Error("LOCAL endpoint is not admitted yet."));
  };
  const pin = options.profile.pin();
  let transport: Awaited<ReturnType<NonNullable<typeof api.listenLocal>>>;
  try {
    transport = await api.listenLocal({
      ownerSid: options.ownerSid,
      packageSid: options.profile.sid,
      accept: (stream) => accept(stream),
      failed: options.failed,
    });
  } catch (cause) {
    pin.release();
    throw cause;
  }
  try {
    const endpoint = await DockerEndpoint.startOwned(
      {
        socketPath: transport.path,
        boundary: createWindowsDockerBoundary({ ...options.paths, endpointSocket: transport.path }),
        upstream: options.upstream,
        // Windows has no AppArmor; the shared proxy only asks Linux local daemons
        // about that feature when configured with a nonempty container profile.
        containerProfile: "",
        onRefusal: options.onRefusal,
      },
      async (handler) => {
        accept = handler;
        return {
          close: async () => {
            await transport.close();
            pin.release();
          },
          closeSync: () => {
            transport.closeSync();
            pin.release();
          },
        };
      },
    );
    return { endpoint, dockerHost: `npipe://${transport.path.replaceAll("\\", "/")}` };
  } catch (cause) {
    await transport.close();
    pin.release();
    throw cause;
  }
}
