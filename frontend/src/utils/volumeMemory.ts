export interface VolumeMemoryPlan {
  planKey: string;
  memoryEpoch: number;
  sourceBytes: number;
  sourceResidentBytes: number;
  sourceIncrementBytes: number;
  numT: number;
  numChannels: number;
  numZ: number;
  height: number;
  width: number;
  originalShape: [number, number, number, number];
  textureBytes: number;
  wireBytes: number;
  serverStageBytes: number;
  planeWorkBytes: number;
}
