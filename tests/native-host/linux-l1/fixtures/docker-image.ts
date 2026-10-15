/** Trusted CI fixture preparation only; never imported by production. */
// Official alpine:3.20 index, verified byte-identical on ECR and Docker Hub.
// Contains linux/amd64 and linux/arm64; no mutable tag fallback is permitted.
const digest = "sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";
export const dockerFixtureImages = [
  `public.ecr.aws/docker/library/alpine@${digest}`,
  `docker.io/library/alpine@${digest}`,
] as const;

/**
 * Same immutable artifact, two official registries. Never skip the mandatory
 * integration suite, accept a different image, or change actor policy on failure.
 * The caller bounds each Docker command; two attempts per registry fit the
 * existing 300s trusted beforeAll budget with 45s per pull.
 */
export async function pullDockerFixtureImage(
  run: (args: string[]) => void,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string> {
  let lastError: unknown;
  for (const reference of dockerFixtureImages) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        run(["pull", "-q", reference]);
        return reference;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await wait(1_000);
      }
    }
  }
  throw new Error("Both official registries failed for the pinned mandatory Docker fixture.", { cause: lastError });
}
