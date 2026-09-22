export interface ApplicationZoomAPI {
  getFactor(): number;
  reset(): void;
  onChanged(listener: (factor: number) => void): () => void;
}
