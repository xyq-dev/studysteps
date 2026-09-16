export type StatusBannerProps = {
  message: string;
};

export function StatusBanner({ message }: StatusBannerProps) {
  return <p role="status">{message}</p>;
}
