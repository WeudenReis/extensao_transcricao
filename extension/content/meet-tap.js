/**
 * meet-tap.js — captura de áudio da reunião (world: MAIN, document_start).
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * A extensão antiga lia a LEGENDA do Meet. Legenda é UI, e UI tem botão de
 * desligar — logo, manipulável. Aqui capturamos uma camada ABAIXO da UI:
 * o próprio áudio do WebRTC. Não existe botão que desligue isso sem encerrar
 * a chamada, e independe de legenda e de conta Workspace (funciona em @gmail).
 *
 * Roda em "world: MAIN" (contexto real da página) e "document_start" (ANTES do
 * Meet carregar) para conseguir embrulhar as APIs antes de o Meet usá-las.
 *
 * TRANSPARÊNCIA: este script apenas capta; a gravação é sinalizada de forma
 * visível pelo content script isolado (banner na página + indicador no popup).
 * O uso pressupõe aviso de consentimento ao cliente (ver docs/CAPTURA-AUDIO.md).
 *
 * Não vaza nada para a página além dos patches necessários; conversa com o
 * mundo isolado só por window.postMessage({source:'chatpro-tap', ...}).
 */
(() => {
  'use strict';

  const TAG = 'chatpro-tap';
  const LOG_PREFIX = '[chatPro tap]';

  function debug(...args) {
    try {
      console.debug(LOG_PREFIX, ...args);
    } catch (_) {
      /* nunca quebrar a página por causa de log */
    }
  }

  /** Envia mensagem para o mundo isolado (meet.js). */
  function post(type, payload, transfer) {
    try {
      window.postMessage(
        Object.assign({ source: TAG, type }, payload || {}),
        '*',
        transfer || []
      );
    } catch (err) {
      debug('postMessage falhou:', err);
    }
  }

  // ===========================================================================
  // Estado da captura
  // ===========================================================================
  const remoteTracks = new Set(); // MediaStreamTrack de áudio dos participantes
  let micTrack = null; // NOSSA clone do microfone (independente do mute do Meet)
  let audioCtx = null;
  let remoteDest = null; // MediaStreamAudioDestinationNode (mix das vozes remotas)
  const connectedRemote = new WeakSet(); // tracks já ligadas ao mix

  const recorders = { mic: null, remote: null };
  const seq = { mic: 0, remote: 0 };
  let capturing = false;
  let started = false;
  let chosenMime = '';

  const TIMESLICE_MS = 5000;

  // ===========================================================================
  // Escolha de mimeType suportado pelo MediaRecorder
  // ===========================================================================
  function pickMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ];
    for (const mime of candidates) {
      try {
        if (
          typeof MediaRecorder !== 'undefined' &&
          MediaRecorder.isTypeSupported &&
          MediaRecorder.isTypeSupported(mime)
        ) {
          return mime;
        }
      } catch (_) {
        /* tenta o próximo */
      }
    }
    return ''; // deixa o browser decidir o default
  }

  // ===========================================================================
  // Gravação de uma trilha ('mic' | 'remote')
  // ===========================================================================
  function startRecorder(track, stream) {
    if (recorders[track]) return; // já gravando essa trilha
    try {
      const options = chosenMime ? { mimeType: chosenMime } : undefined;
      const recorder = new MediaRecorder(stream, options);

      recorder.ondataavailable = (event) => {
        const blob = event.data;
        if (!blob || blob.size === 0) return;
        // Converte para ArrayBuffer (transferível entre mundos via postMessage).
        blob
          .arrayBuffer()
          .then((buffer) => {
            const n = seq[track]++;
            post('CHUNK', { track, seq: n, mimeType: chosenMime, buffer }, [
              buffer,
            ]);
          })
          .catch((err) => debug('falha ao ler blob:', err));
      };

      recorder.onerror = (event) => debug('erro no recorder', track, event);
      recorder.start(TIMESLICE_MS);
      recorders[track] = recorder;
      debug('gravando trilha', track);
    } catch (err) {
      debug('não consegui iniciar recorder', track, err);
    }
  }

  function stopRecorder(track) {
    const recorder = recorders[track];
    if (!recorder) return;
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch (err) {
      debug('falha ao parar recorder', track, err);
    }
    recorders[track] = null;
  }

  // ===========================================================================
  // Ciclo de captura: começa quando há mic clonado OU voz remota; para quando
  // não há mais nenhum sinal de chamada ativa.
  // ===========================================================================
  function ensureAudioContext() {
    if (audioCtx) {
      // Um AudioContext suspenso também grava silêncio — reativa sempre.
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return;
    }
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      remoteDest = audioCtx.createMediaStreamDestination();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch (err) {
      debug('AudioContext indisponível:', err);
    }
  }

  // Mantém os elementos <audio> vivos (não podem ser coletados pelo GC).
  const sinks = [];

  function connectRemoteTrack(track) {
    if (!audioCtx || !remoteDest) return;
    if (connectedRemote.has(track)) return;
    try {
      const stream = new MediaStream([track]);

      // ATENÇÃO (bug real de produção): no Chrome, faixa remota de WebRTC
      // roteada SÓ pelo Web Audio grava 155s de silêncio absoluto (RMS 0).
      // O áudio só "flui" se o stream também estiver preso a um <audio>.
      // Criamos um sink mudo (muted) só pra destravar o fluxo — quem toca a
      // reunião de verdade continua sendo o player do próprio Meet.
      const sink = new Audio();
      sink.srcObject = stream;
      sink.muted = true;
      sink.autoplay = true;
      sink.play().catch(() => {
        /* autoplay bloqueado não impede a captura */
      });
      sinks.push(sink);

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(remoteDest);
      connectedRemote.add(track);
      debug('voz remota conectada ao mix (com sink de áudio)');
    } catch (err) {
      debug('falha ao conectar track remota ao mix:', err);
    }
  }

  function hasActiveCall() {
    const micLive = micTrack && micTrack.readyState === 'live';
    return Boolean(micLive || remoteTracks.size > 0);
  }

  function evaluateCapture() {
    if (!hasActiveCall()) {
      if (capturing) stopCapture('call-ended');
      return;
    }

    ensureAudioContext();
    if (!chosenMime) chosenMime = pickMimeType();

    if (!started) {
      started = true;
      capturing = true;
      post('CAPTURE_START', { mimeType: chosenMime, mode: 'webrtc-tap' });
    }

    // Trilha do microfone (nossa clone).
    if (micTrack && micTrack.readyState === 'live' && !recorders.mic) {
      startRecorder('mic', new MediaStream([micTrack]));
    }

    // Trilha remota (mix das vozes dos participantes).
    for (const track of remoteTracks) connectRemoteTrack(track);
    if (remoteDest && remoteTracks.size > 0 && !recorders.remote) {
      startRecorder('remote', remoteDest.stream);
    }

    emitStats();
  }

  function stopCapture(reason) {
    if (!started) return;
    capturing = false;
    stopRecorder('mic');
    stopRecorder('remote');
    post('CAPTURE_STOP', {
      reason: reason || 'call-ended',
      totalChunks: { mic: seq.mic, remote: seq.remote },
    });
    started = false;
    debug('captura encerrada:', reason);
  }

  function emitStats() {
    post('STATS', {
      capturing,
      micActive: Boolean(micTrack && micTrack.readyState === 'live'),
      remoteTracks: remoteTracks.size,
    });
  }

  // ===========================================================================
  // MONKEYPATCH 1 — RTCPeerConnection: captura as vozes remotas.
  //
  // Toda chamada do Meet cria RTCPeerConnection(s). As faixas de áudio que
  // CHEGAM (evento 'track', kind 'audio') são as vozes dos outros participantes
  // — ou seja, o cliente. É o áudio que já entra no seu navegador para você
  // ouvir: a reunião não acontece sem ele, então não há como "desligar".
  // Preservamos protótipo e comportamento para não quebrar o Meet.
  // ===========================================================================
  function patchRTCPeerConnection() {
    const Native = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (!Native) {
      debug('RTCPeerConnection ausente — sem patch de voz remota');
      return;
    }

    function Patched(...args) {
      const pc = new Native(...args);
      try {
        pc.addEventListener('track', (event) => {
          try {
            const track = event.track;
            if (!track || track.kind !== 'audio') return;
            remoteTracks.add(track);
            track.addEventListener('ended', () => {
              remoteTracks.delete(track);
              evaluateCapture();
            });
            debug('voz remota capturada; total:', remoteTracks.size);
            evaluateCapture();
          } catch (err) {
            debug('erro no handler de track:', err);
          }
        });
      } catch (err) {
        debug('não consegui escutar track na pc:', err);
      }
      return pc;
    }

    // Preserva protótipo, estáticos e instanceof.
    Patched.prototype = Native.prototype;
    try {
      Object.setPrototypeOf(Patched, Native);
    } catch (_) {
      /* ok se falhar */
    }
    try {
      window.RTCPeerConnection = Patched;
      if (window.webkitRTCPeerConnection) {
        window.webkitRTCPeerConnection = Patched;
      }
      debug('RTCPeerConnection embrulhado');
    } catch (err) {
      debug('falha ao instalar patch de RTCPeerConnection:', err);
    }
  }

  // ===========================================================================
  // MONKEYPATCH 2 — getUserMedia: clona o microfone de forma INDEPENDENTE.
  //
  // O botão de MUTE do Meet seta enabled=false na track de microfone DELE.
  // Nós ficamos com uma CLONE (track.clone()) cujo 'enabled' é independente:
  // mutar no Meet silencia para os participantes, mas a nossa cópia continua
  // captando. Forçamos enabled=true na clone e reforçamos periodicamente.
  // ESSA é a propriedade anti-manipulação do microfone.
  // ===========================================================================
  function patchGetUserMedia() {
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) {
      debug('getUserMedia ausente — sem patch de microfone');
      return;
    }
    const originalGUM = md.getUserMedia.bind(md);

    md.getUserMedia = async function (constraints) {
      const stream = await originalGUM(constraints);
      try {
        const wantsAudio = constraints && constraints.audio;
        if (wantsAudio) {
          const audioTracks = stream.getAudioTracks();
          if (audioTracks.length > 0) {
            // O Meet chama getUserMedia MAIS DE UMA VEZ (lobby → chamada, troca
            // de microfone, renegociação). A cada vez trocamos a clone — e é
            // OBRIGATÓRIO derrubar o gravador antigo junto, senão ele fica preso
            // a uma track morta e a gravação do microfone para calada (bug real:
            // 1 pedaço de 5s numa call de 2min).
            const anterior = micTrack;
            micTrack = audioTracks[0].clone();
            micTrack.enabled = true;
            stopRecorder('mic'); // força recriar o gravador na nova clone
            if (anterior) {
              try {
                anterior.stop();
              } catch (_) {
                /* ignore */
              }
            }
            // Se a clone acabar sozinha, também recria.
            micTrack.addEventListener('ended', () => {
              debug('clone do microfone terminou');
              stopRecorder('mic');
              evaluateCapture();
            });
            debug('microfone clonado (independente do mute do Meet)');
            evaluateCapture();
          }
        }
      } catch (err) {
        debug('falha ao clonar microfone:', err);
      }
      return stream; // o Meet recebe o stream original, intacto
    };
    debug('getUserMedia embrulhado');
  }

  // ===========================================================================
  // Reforços periódicos e encerramento
  // ===========================================================================
  function startKeepAlive() {
    // A cada 2s: reforça enabled=true na clone (o Meet pode tentar desabilitar
    // por caminhos internos) e reavalia o estado da captura.
    setInterval(() => {
      try {
        if (micTrack && micTrack.readyState === 'live') micTrack.enabled = true;
        // Limpa tracks remotas mortas que não dispararam 'ended'.
        for (const track of remoteTracks) {
          if (track.readyState !== 'live') remoteTracks.delete(track);
        }
        // Cinto de segurança: se um gravador parou sozinho (track trocada,
        // erro interno), derruba a referência pra evaluateCapture recriá-lo.
        for (const nome of ['mic', 'remote']) {
          const rec = recorders[nome];
          if (rec && rec.state === 'inactive') {
            debug('gravador', nome, 'estava inativo — recriando');
            recorders[nome] = null;
          }
        }
        evaluateCapture();
      } catch (err) {
        debug('erro no keep-alive:', err);
      }
    }, 2000);

    window.addEventListener('pagehide', () => stopCapture('tab-closed'));
    window.addEventListener('beforeunload', () => stopCapture('tab-closed'));
  }

  // ===========================================================================
  // Bootstrap — instala os patches o mais cedo possível.
  // ===========================================================================
  try {
    patchRTCPeerConnection();
    patchGetUserMedia();
    startKeepAlive();
    debug('tap instalado');
  } catch (err) {
    debug('falha no bootstrap do tap:', err);
  }
})();
