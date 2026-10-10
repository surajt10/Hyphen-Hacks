const TFJS_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
const YAMNET_URL = "https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1";

const GUN = [421, 422, 423, 424, 425];
const FIREWORKS = [426, 427];

export type Detection = { confidence: number; label: "gunshot" | "loud-bang"; at: number; onset?: number };

let modelPromise: Promise<any> | null = null;

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    if ((window as any).tf) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("tfjs failed to load"));
    document.head.appendChild(s);
  });
}

export function loadYamnet() {
  modelPromise ??= loadScript(TFJS_URL).then(() =>
    (window as any).tf.loadGraphModel(YAMNET_URL, { fromTFHub: true }),
  );
  return modelPromise;
}

function resampleTo16k(buf: Float32Array, rate: number) {
  const ratio = rate / 16000;
  const out = new Float32Array(Math.floor(buf.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0;
    out[i] = buf[i0] * (1 - f) + (buf[i0 + 1] ?? buf[i0]) * f;
  }
  return out;
}

function gunThreshold(d = new Date()) {
  const md = `${d.getMonth() + 1}-${d.getDate()}`;
  return ["7-4", "7-5", "12-31", "1-1"].includes(md) ? 0.5 : 0.25;
}

export class SoundWatcher {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: ScriptProcessorNode;
  private ring = new Float32Array(0);
  private pos = 0;
  private background = 0.01;
  private cooldownUntil = 0;
  modelReady = false;

  async start(onDetect: (d: Detection) => void, onLevel?: (db: number) => void) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new AudioContext();
    await this.ctx.resume();
    const rate = this.ctx.sampleRate;
    this.ring = new Float32Array(Math.round(rate * 1.0));
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(2048, 1, 1);
    src.connect(this.node);
    this.node.connect(this.ctx.destination);
    loadYamnet().then(() => (this.modelReady = true)).catch(() => (this.modelReady = false));

    this.node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      let sum = 0, peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        sum += v * v;
        if (Math.abs(v) > peak) peak = Math.abs(v);
        this.ring[this.pos] = v;
        this.pos = (this.pos + 1) % this.ring.length;
      }
      const rms = Math.sqrt(sum / data.length);
      onLevel?.(20 * Math.log10(rms + 1e-6));
      const now = performance.now();
      const impulse = peak > 0.4 && rms > this.background * 6 && rms > 0.04;
      this.background = this.background * 0.98 + Math.min(rms, 0.2) * 0.02;
      if (impulse && now > this.cooldownUntil) {
        this.cooldownUntil = now + 3000;
        let idx = 0;
        while (idx < data.length && Math.abs(data[idx]) < peak * 0.5) idx++;
        const ctx = this.ctx!;
        const onsetCtx = ctx.currentTime - (data.length - idx) / rate;
        const ts = ctx.getOutputTimestamp?.();
        const perf = ts?.performanceTime !== undefined && ts.contextTime !== undefined ? ts.performanceTime + (onsetCtx - ts.contextTime) * 1000 : now - ((data.length - idx) / rate) * 1000;
        const onset = performance.timeOrigin + perf;
        setTimeout(() => this.classify(rate).then((d) => d && onDetect({ ...d, onset })), 300);
      }
    };
  }

  private snapshot() {
    const out = new Float32Array(this.ring.length);
    out.set(this.ring.subarray(this.pos));
    out.set(this.ring.subarray(0, this.pos), this.ring.length - this.pos);
    return out;
  }

  private async classify(rate: number): Promise<Detection | null> {
    const at = Date.now();
    if (!this.modelReady) return { confidence: 0.3, label: "loud-bang", at };
    try {
      const tf = (window as any).tf;
      const model = await loadYamnet();
      const wave = tf.tensor1d(resampleTo16k(this.snapshot(), rate));
      const out = await model.executeAsync(wave);
      const scoresT = Array.isArray(out) ? out[0] : out;
      const scores: number[][] = await scoresT.array();
      tf.dispose([wave, ...(Array.isArray(out) ? out : [out])]);
      const maxOf = (ids: number[]) => Math.max(...scores.map((f) => Math.max(...ids.map((i) => f[i]))));
      const gun = maxOf(GUN), fire = maxOf(FIREWORKS);
      if (gun >= gunThreshold() && gun > fire * 1.5) return { confidence: gun, label: "gunshot", at };
      return null;
    } catch {
      return { confidence: 0.3, label: "loud-bang", at };
    }
  }

  stop() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.node = undefined;
  }
}
