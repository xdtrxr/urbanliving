import { useEffect, useRef, useState, useCallback } from 'react';

// Thin wrapper around the browser SpeechRecognition API.
//
// Usage:
//   const { isSupported, isListening, transcript, start, stop, reset } = useSpeechToText({
//     onFinal: (text) => setInput((prev) => (prev ? `${prev} ${text}` : text)),
//     lang: 'en-US',
//   });
//
// Supported in Chrome, Edge, Safari (desktop). iOS Safari is partial.
// When unsupported, `isSupported` is false and `start()` is a no-op so the
// caller can hide the mic button.

export function useSpeechToText({ onFinal, onInterim, lang = 'en-US', continuous = false } = {}) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);
  const onFinalRef = useRef(onFinal);
  const onInterimRef = useRef(onInterim);

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
      setError(event.error || 'speech error');
      setIsListening(false);
    };
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    return () => {
      try { recognition.stop(); } catch { /* noop */ }
      recognitionRef.current = null;
    };
  }, [Ctor, lang, continuous]);

  const start = useCallback(() => {
    setError(null);
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.start();
      setIsListening(true);
    } catch (err) {
      // start() can throw if already running; treat as no-op
      console.warn('SpeechRecognition.start failed:', err);
    }
  }, []);

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
