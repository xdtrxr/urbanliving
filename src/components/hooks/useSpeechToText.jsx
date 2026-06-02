import { useEffect, useRef, useState, useCallback } from 'react';

// Thin wrapper around the browser SpeechRecognition API.
//
// Usage:
//   const { isSupported, isListening, transcript, error, start, stop } = useSpeechToText({
//     onFinal: (text) => setInput((prev) => (prev ? `${prev} ${text}` : text)),
//     lang: 'en-US',
//   });
//
// Supported in Chrome, Edge, Android Chrome, and desktop Safari. iOS Safari
// exposes the API but the engine is unreliable, so we treat it as supported
// and let onerror surface real failures.
//
// Errors that DO bubble up to the caller via `error`:
//   - 'not-allowed' / 'service-not-allowed'  → mic permission blocked
//   - 'audio-capture'                        → no mic on device
//   - 'network'                              → offline / firewall blocked the speech endpoint
//   - 'no-speech'                            → silence timeout (we treat as benign and clear)
//   - 'aborted'                              → stop() called (benign, cleared)

export function useSpeechToText({ onFinal, onInterim, lang = 'en-US', continuous = false } = {}) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);
  const onFinalRef = useRef(onFinal);
  const onInterimRef = useRef(onInterim);
  const permissionGrantedRef = useRef(false);

  useEffect(() => { onFinalRef.current = onFinal; }, [onFinal]);
  useEffect(() => { onInterimRef.current = onInterim; }, [onInterim]);

  const Ctor = typeof window !== 'undefined'
    ? (window.SpeechRecognition || window.webkitSpeechRecognition)
    : null;
  const isSupported = !!Ctor;

  useEffect(() => {
    if (!Ctor) return undefined;
    const recognition = new Ctor();
    recognition.continuous = continuous;
    recognition.interimResults = true;
    recognition.lang = lang;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const r = event.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      if (interimText) {
        setTranscript(interimText);
        onInterimRef.current?.(interimText);
      }
      if (finalText) {
        setTranscript('');
        onFinalRef.current?.(finalText.trim());
      }
    };
    recognition.onerror = (event) => {
      const code = event?.error || 'speech-error';
      // 'no-speech' and 'aborted' are benign UX events, not failures the user
      // needs to see. Only surface real problems.
      if (code === 'no-speech' || code === 'aborted') {
        setIsListening(false);
        return;
      }
      const friendly = (() => {
        switch (code) {
          case 'not-allowed':
          case 'service-not-allowed':
            return 'Microphone access blocked. Please allow mic access for this site in your browser settings.';
          case 'audio-capture':
            return 'No microphone detected on this device.';
          case 'network':
            return 'Speech recognition needs an internet connection. Please check your connection.';
          case 'language-not-supported':
            return 'Speech recognition language not supported by this browser.';
          default:
            return `Voice input error: ${code}. Try again, or type instead.`;
        }
      })();
      setError(friendly);
      setIsListening(false);
      console.warn('SpeechRecognition error:', code);
    };
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    return () => {
      try { recognition.stop(); } catch { /* noop */ }
      recognitionRef.current = null;
    };
  }, [Ctor, lang, continuous]);

  // Pre-request mic permission with getUserMedia so the browser prompts the
  // user up-front. SpeechRecognition.start() does NOT trigger a permission
  // prompt on some browsers (notably Chrome with strict policies and any
  // embedded webview), so without this gesture the call silently no-ops.
  const ensureMicPermission = useCallback(async () => {
    if (permissionGrantedRef.current) return true;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      // Older browser — skip and hope recognition.start() prompts on its own.
      return true;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Release the stream immediately — SpeechRecognition manages its own capture.
      stream.getTracks().forEach((t) => t.stop());
      permissionGrantedRef.current = true;
      return true;
    } catch (err) {
      const code = err?.name || 'mic-error';
      const friendly = code === 'NotAllowedError' || code === 'SecurityError'
        ? 'Microphone access blocked. Please allow mic access for this site in your browser settings.'
        : code === 'NotFoundError'
          ? 'No microphone detected on this device.'
          : `Could not access microphone (${code}).`;
      setError(friendly);
      console.warn('getUserMedia failed:', err);
      return false;
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (!recognitionRef.current) {
      setError('Voice input is not available in this browser.');
      return;
    }
    const ok = await ensureMicPermission();
    if (!ok) return;
    try {
      recognitionRef.current.start();
      setIsListening(true);
    } catch (err) {
      // start() throws if already running — treat as no-op, otherwise surface.
      const name = err?.name || 'StartError';
      if (name === 'InvalidStateError') return;
      setError(`Could not start voice input (${name}).`);
      console.warn('SpeechRecognition.start failed:', err);
    }
  }, [ensureMicPermission]);

  const stop = useCallback(() => {
    if (!recognitionRef.current) return;
    try { recognitionRef.current.stop(); } catch { /* noop */ }
    setIsListening(false);
  }, []);

  const reset = useCallback(() => {
    setTranscript('');
    setError(null);
  }, []);

  return { isSupported, isListening, transcript, error, start, stop, reset };
}
