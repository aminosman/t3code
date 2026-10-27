/** AVAudioSessionRouteChangeReason values for hardware arrival and removal. */
export function isHeadphoneRouteChange(reason: unknown): boolean {
  return reason === 1 || reason === 2;
}
