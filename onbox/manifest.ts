import { hostsFor, service, serviceNames } from "../fleet/inv";

export type VolumeSpec = {
  svc: string;
  vol: string;
  hosts: string[];
  sqlite: string[];
  file: string[];
};
export type BackupManifest = { volumes: VolumeSpec[] };

export function buildManifest(): BackupManifest {
  const volumes: VolumeSpec[] = [];
  for (const svc of serviceNames()) {
    for (const [vol, spec] of Object.entries(service(svc).volumes)) {
      if (spec.backup.sqlite.length === 0 && spec.backup.file.length === 0) continue;
      volumes.push({
        svc,
        vol,
        hosts: hostsFor(svc, []),
        sqlite: [...spec.backup.sqlite],
        file: [...spec.backup.file],
      });
    }
  }
  return { volumes };
}

export async function loadManifest(path: string): Promise<VolumeSpec[]> {
  const doc = (await Bun.file(path).json()) as { volumes?: VolumeSpec[] };
  if (!doc || !Array.isArray(doc.volumes)) throw new Error(`bad manifest: ${path}`);
  return doc.volumes;
}

export function selectVolumes(volumes: VolumeSpec[], box: string): VolumeSpec[] {
  return volumes.filter((v) => v.hosts.includes(box));
}
