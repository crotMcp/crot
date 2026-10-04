import { describe, expect, it } from "vitest";
import {
  COMPOSE_FILE_MAX_BYTES,
  reviewComposeModel,
  scanComposeSource,
} from "../../src/core/capabilities/docker/compose-policy.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("scanComposeSource", () => {
  it("accepts an ordinary Compose file", () => {
    const yaml = [
      "services:",
      "  web:",
      "    image: nginx:alpine",
      '    command: ["nginx", "-g", "daemon off;"]',
      "    environment:",
      '      GREETING: "hello\\tworld"',
      "      INCLUDES: yes",
      "    volumes: [./data:/data:ro]",
      "",
    ].join("\n");
    expect(() => scanComposeSource(bytes(yaml), "compose.yaml")).not.toThrow();
  });

  it.each([
    ["include", "include:\n  - other.yaml\n"],
    ["include in flow style", "{include: [other.yaml], services: {}}"],
    ["include as JSON", '{"include": ["other.yaml"]}'],
    ["extends", "services:\n  web:\n    extends: {file: base.yaml, service: web}\n"],
    ["label_file", "services:\n  web:\n    label_file: ./labels\n"],
    ["a hexadecimal escape", 'services:\n  web:\n    "\\x65xtends": {}\n'],
    ["a unicode escape", '{"services": {"web": {"\\u0065xtends": {}}}}'],
    ["a long unicode escape", 'services:\n  web:\n    "\\U00000065xtends": {}\n'],
    ["an escaped line break", 'services:\n  web:\n    "ext\\\nends": {}\n'],
    ["a binary tag", "services:\n  web: !!binary ZXh0ZW5kcw==\n"],
    ["a verbatim tag", "services:\n  web: !<tag:yaml.org,2002:str> x\n"],
    ["a directive", "%YAML 1.2\n---\nservices: {}\n"],
    ["a NUL character", "services: {}\n\0"],
  ])("refuses %s", (_name, text) => {
    expect(() => scanComposeSource(bytes(text), "compose.yaml")).toThrow(
      expect.objectContaining({ code: "UNSAFE_COMPOSE" }),
    );
  });

  it("refuses files that are not UTF-8 or too large", () => {
    expect(() => scanComposeSource(new Uint8Array([0xff, 0xfe, 0x73, 0x00]), "utf16.yaml")).toThrow(
      expect.objectContaining({ code: "UNSAFE_COMPOSE" }),
    );
    expect(() => scanComposeSource(new Uint8Array(COMPOSE_FILE_MAX_BYTES + 1), "big.yaml")).toThrow(
      expect.objectContaining({ code: "UNSAFE_COMPOSE" }),
    );
  });
});

/** Normalized model as printed by `docker compose config --format json` (Compose v2). */
function model(service: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "demo",
    services: {
      web: { image: "nginx:alpine", command: null, entrypoint: null, networks: { default: null }, ...service },
    },
    networks: { default: { name: "demo_default", ipam: {} } },
    ...top,
  };
}

describe("reviewComposeModel", () => {
  it("accepts a typical project and lists every host path", () => {
    const review = reviewComposeModel(
      model(
        {
          environment: { A: "1" },
          ports: [{ mode: "ingress", host_ip: "127.0.0.1", target: 80, published: "8080", protocol: "tcp" }],
          volumes: [
            {
              type: "bind",
              source: "/ws/app/data",
              target: "/data",
              read_only: true,
              bind: { create_host_path: true },
            },
            { type: "bind", source: "/ws/app/cache", target: "/cache", bind: { selinux: "z" } },
            { type: "volume", source: "pg", target: "/var/lib/postgresql/data", volume: {} },
            { type: "tmpfs", target: "/tmp", tmpfs: { size: 1024 } },
          ],
          secrets: [{ source: "pw", target: "/run/secrets/pw" }],
          depends_on: { db: { condition: "service_healthy", required: true } },
          healthcheck: { test: ["CMD", "true"], interval: "5s" },
          deploy: { resources: { limits: { cpus: 0.5, memory: "104857600" } }, placement: {} },
          security_opt: ["no-new-privileges:true"],
          cap_drop: ["ALL"],
          labels: { "org.example.team": "web" },
          restart: "unless-stopped",
          user: "1000:1000",
          read_only: true,
          "x-notes": "anything",
        },
        {
          volumes: { pg: { name: "demo_pg" } },
          secrets: { pw: { name: "demo_pw", file: "/ws/app/pw.txt" } },
          configs: { conf: { name: "demo_conf", content: "hello" } },
          "x-common": { anything: true },
        },
      ),
    );
    expect(review.name).toBe("demo");
    expect(review.services).toEqual(["web"]);
    expect(review.external).toEqual([]);
    expect(review.hostPaths.map((p) => [p.kind, p.source, p.readOnly])).toEqual([
      ["bind", "/ws/app/data", true],
      ["bind", "/ws/app/cache", false],
      ["secret", "/ws/app/pw.txt", true],
    ]);
  });

  it("lets the caller replace host paths with canonical ones", () => {
    const m = model({ volumes: [{ type: "bind", source: "/ws/link", target: "/x" }] });
    const review = reviewComposeModel(m);
    review.hostPaths[0]!.replace("/real/target");
    expect(m).toMatchObject({ services: { web: { volumes: [{ source: "/real/target" }] } } });
  });

  it("reports external volumes", () => {
    const review = reviewComposeModel(
      model(
        { volumes: [{ type: "volume", source: "shared", target: "/s" }] },
        { volumes: { shared: { name: "shared", external: true } } },
      ),
    );
    expect(review.external).toHaveLength(1);
  });

  it.each([
    ["an unknown top-level key", model({}, { models: {} })],
    ["no services", { name: "demo", services: {} }],
    ["a service without image", { services: { web: { build: { context: "." } } } }],
    ["build", model({ build: { context: "." } })],
    ["develop/watch", model({ develop: { watch: [] } })],
    ["privileged", model({ privileged: true })],
    ["cap_add", model({ cap_add: ["NET_ADMIN"] })],
    ["devices", model({ devices: ["/dev/kvm"] })],
    ["device cgroup rules", model({ device_cgroup_rules: ["a *:* rwm"] })],
    ["gpus", model({ gpus: "all" })],
    ["host network mode", model({ network_mode: "host" })],
    ["a container's network", model({ network_mode: "container:other" })],
    ["host pid", model({ pid: "host" })],
    ["host ipc", model({ ipc: "host" })],
    ["host uts", model({ uts: "host" })],
    ["host user namespace", model({ userns_mode: "host" })],
    ["host cgroup namespace", model({ cgroup: "host" })],
    ["a cgroup parent", model({ cgroup_parent: "/" })],
    ["apparmor unconfined", model({ security_opt: ["apparmor=unconfined"] })],
    ["sysctls", model({ sysctls: { "net.ipv4.ip_forward": 1 } })],
    ["a runtime", model({ runtime: "runc-custom" })],
    ["a logging driver", model({ logging: { driver: "syslog", options: { "syslog-address": "tcp://x" } } })],
    ["a volume driver", model({ volume_driver: "local-persist" })],
    ["external links", model({ external_links: ["other_db_1"] })],
    ["volumes of a container", model({ volumes_from: ["container:other"] })],
    ["the Docker API socket", model({ use_api_socket: true })],
    ["lifecycle hooks", model({ post_start: [{ command: "id" }] })],
    ["a provider", model({ provider: { type: "model" } })],
    ["env_file left in the model", model({ env_file: [{ path: "/x" }] })],
    ["pull_policy always", model({ pull_policy: "always" })],
    ["pull_policy build", model({ pull_policy: "build" })],
    ["a Compose label", model({ labels: { "com.docker.compose.project": "other" } })],
    ["a Compose label in deploy", model({ deploy: { labels: ["com.docker.compose.service=x"] } })],
    ["GPU reservations", model({ deploy: { resources: { reservations: { devices: [{ capabilities: ["gpu"] }] } } } })],
    ["an npipe mount", model({ volumes: [{ type: "npipe", source: "//./pipe/docker_engine", target: "/p" }] })],
    ["an image mount", model({ volumes: [{ type: "image", source: "alpine", target: "/img" }] })],
    ["a bind without source", model({ volumes: [{ type: "bind", target: "/x" }] })],
    [
      "shared propagation",
      model({ volumes: [{ type: "bind", source: "/ws", target: "/x", bind: { propagation: "rshared" } }] }),
    ],
    [
      "an unknown mount option",
      model({ volumes: [{ type: "volume", source: "v", target: "/v", volume: { driver: "x" } }] }),
    ],
    ["network endpoint driver options", model({ networks: { default: { driver_opts: { x: "y" } } } })],
    [
      "a volume driver option bind",
      model({}, { volumes: { v: { driver: "local", driver_opts: { o: "bind", device: "/etc" } } } }),
    ],
    ["a volume plugin", model({}, { volumes: { v: { driver: "rexray/ebs" } } })],
    ["a network driver", model({}, { networks: { n: { driver: "macvlan" } } })],
    ["network driver options", model({}, { networks: { n: { driver_opts: { parent: "eth0" } } } })],
    ["the host network", model({}, { networks: { n: { name: "host", external: true } } })],
    ["a custom IPAM driver", model({}, { networks: { n: { ipam: { driver: "custom" } } } })],
    ["external secrets", model({}, { secrets: { s: { external: true } } })],
    ["secrets from the environment", model({}, { secrets: { s: { environment: "AWS_SECRET_ACCESS_KEY" } } })],
    ["configs from the environment", model({}, { configs: { c: { environment: "HOME" } } })],
  ])("refuses %s", (_name, m) => {
    expect(() => reviewComposeModel(m)).toThrow(expect.objectContaining({ code: "UNSAFE_COMPOSE" }));
  });

  it("lists every violation", () => {
    try {
      reviewComposeModel(model({ privileged: true, cap_add: ["ALL"], network_mode: "host" }));
      expect.unreachable();
    } catch (error) {
      expect((error as { details: { violations: string[] } }).details.violations).toHaveLength(3);
    }
  });
});
