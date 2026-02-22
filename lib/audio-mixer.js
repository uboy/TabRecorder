/**
 * AudioMixer — ES module
 *
 * Mixes a tab MediaStream and an optional mic MediaStream into a single
 * combined MediaStream containing the original tab video track and a
 * single mixed audio track.
 *
 * All audio routing uses the Web Audio API so the AudioContext is
 * created externally (in offscreen.js) and injected here, keeping
 * this class independently testable.
 */
export class AudioMixer {
  /**
   * @param {AudioContext} audioContext
   */
  constructor(audioContext) {
    this._ctx = audioContext;
    this._nodes = [];
  }

  /**
   * Mix tab audio (and optionally mic audio) into a single output stream.
   *
   * @param {MediaStream} tabStream  — the full tab MediaStream (video + audio)
   * @param {MediaStream|null} micStream — optional microphone MediaStream
   * @returns {MediaStream} combined stream: tab video track + mixed audio track
   */
  mix(tabStream, micStream = null) {
    const ctx = this._ctx;
    const destination = ctx.createMediaStreamDestination();
    this._nodes.push(destination);

    // Route tab audio through its own gain node into the destination
    const tabAudioTracks = tabStream.getAudioTracks();
    if (tabAudioTracks.length > 0) {
      const tabSource = ctx.createMediaStreamSource(
        new MediaStream(tabAudioTracks)
      );
      const tabGain = ctx.createGain();
      tabGain.gain.value = 1.0;

      tabSource.connect(tabGain);
      tabGain.connect(destination);

      this._nodes.push(tabSource, tabGain);
    }

    // Route mic audio through its own gain node into the same destination
    if (micStream) {
      const micAudioTracks = micStream.getAudioTracks();
      if (micAudioTracks.length > 0) {
        const micSource = ctx.createMediaStreamSource(
          new MediaStream(micAudioTracks)
        );
        const micGain = ctx.createGain();
        micGain.gain.value = 1.0;

        micSource.connect(micGain);
        micGain.connect(destination);

        this._nodes.push(micSource, micGain);
      }
    }

    // Combine the tab's video track with the mixed audio track
    const videoTracks = tabStream.getVideoTracks();
    const mixedAudioTracks = destination.stream.getAudioTracks();
    const combinedTracks = [...videoTracks, ...mixedAudioTracks];

    return new MediaStream(combinedTracks);
  }

  /**
   * Disconnect all audio graph nodes and close the AudioContext.
   * Must be called when recording stops to free resources.
   */
  destroy() {
    for (const node of this._nodes) {
      try {
        node.disconnect();
      } catch {
        // Node may already be disconnected; ignore
      }
    }
    this._nodes = [];

    if (this._ctx && this._ctx.state !== 'closed') {
      this._ctx.close().catch(() => {
        // Context close is best-effort
      });
    }
  }
}
