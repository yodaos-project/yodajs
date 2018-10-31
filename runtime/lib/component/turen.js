var logger = require('logger')('turen')
var fs = require('fs')

var _ = require('@yoda/util')._
var wifi = require('@yoda/wifi')
var Caps = require('@yoda/flora').Caps
var bluetooth = require('@yoda/bluetooth')

var VT_WORDS_ADD_WORD_CHANNEL = 'rokid.turen.addVtWord'
var VT_WORDS_DEL_WORD_CHANNEL = 'rokid.turen.removeVtWord'

module.exports = Turen
function Turen (runtime) {
  this.runtime = runtime

  /**
   * indicates microphone muted or not.
   */
  this.muted = false

  /** if device is awaken */
  this.awaken = false
  /**
   * asr parsing state, possible values:
   * - pending
   * - fake
   * - end
   */
  this.asrState = 'end'
  /**
   * Turen picking up state.
   */
  this.pickingUp = false
  /**
   * if next nlp shall be discarded.
   */
  this.pickingUpDiscardNext = false

  /**
   * handle of timer to determines if current 'voice coming' session is alone,
   * no upcoming asr pending/end is sent in company with it.
   */
  this.solitaryVoiceComingTimeout = process.env.YODA_SOLITARY_VOICE_COMING_TIMEOUT || 3000
  this.solitaryVoiceComingTimer = null
  /**
   * handle of timer to determines if current awaken session is no voice input available so far,
   * no upcoming asr pending would be sent any way.
   */
  this.noVoiceInputTimeout = process.env.YODA_NO_VOICE_INPUT_TIMEOUT || 6000
  this.noVoiceInputTimer = null
}

Turen.prototype.init = function init () {
  if (this.bluetoothPlayer) {
    this.destruct()
  }
  this.bluetoothPlayer = bluetooth.getPlayer()
}

Turen.prototype.destruct = function destruct () {
  if (this.bluetoothPlayer == null) {
    return
  }
  this.bluetoothPlayer._flora.destruct()
}

/**
 * handles event received from turenproc
 * @param {string} name -
 * @param {object} data -
 * @private
 */
Turen.prototype.handleEvent = function (name, data) {
  if (this.muted) {
    logger.error('Mic muted, unexpected event from Turen:', name)
    return
  }
  var handler = null
  switch (name) {
    case 'voice coming':
      handler = this.handleVoiceComing
      break
    case 'voice local awake':
      handler = this.handleVoiceLocalAwake
      break
    case 'asr pending':
      handler = this.handleAsrPending
      break
    case 'asr end':
      handler = this.handleAsrEnd
      break
    case 'asr fake':
      handler = this.handleAsrFake
      break
    case 'start voice':
      handler = this.handleStartVoice
      break
    case 'end voice':
      handler = this.handleEndVoice
      break
    case 'nlp':
      handler = this.handleNlpResult
      break
    case 'malicious nlp':
      handler = this.handleMaliciousNlpResult
      break
    case 'speech error':
      handler = this.handleSpeechError
      break
  }
  if (typeof handler !== 'function') {
    logger.info(`skip turen event "${name}" for no handler existing`)
    return
  }
  logger.debug(`handling turen event "${name}"`)
  return handler.call(this, data)
}

/**
 * Set device awaken state and appearance.
 */
Turen.prototype.setAwaken = function setAwaken () {
  var promises = []
  if (this.awaken) {
    logger.warn('already awaken')
  }
  this.awaken = true

  var currAppId = this.runtime.life.getCurrentAppId()
  logger.info('awaking, current app', currAppId)

  /**
   * pause lifetime to prevent incoming app preemption;
   * doesn't care when pauseLifetime ends.
   */
  this.runtime.life.pauseLifetime()

  /**
   * no need to determine if tts is previously been paused.
   */
  return Promise.all(promises)
}

/**
 * Set device end of awaken and remove awaken effects.
 *
 * @private
 * @param {object} [options] -
 * @param {boolean} [options.recover] - if recover previous paused app
 */
Turen.prototype.resetAwaken = function resetAwaken (options) {
  var recover = _.get(options, 'recover', true)

  if (!this.awaken) {
    logger.warn('runtime was not awaken, skipping reset awaken')
    return Promise.resolve()
  }
  this.awaken = false
  logger.info('reset awaken, recovering?', recover)

  var promises = [
    this.runtime.light.stop('@yoda', 'system://awake.js'),
    this.runtime.life.resumeLifetime({ recover: recover })
  ]

  if (!recover) {
    // do not stop previously paused tts. let the app handle it theirself
    return Promise.all(promises)
  }

  return Promise.all(promises.concat(this.recoverPausedOnAwaken()))
}

/**
 * Recovers paused tts/media on awaken.
 * @private
 */
Turen.prototype.recoverPausedOnAwaken = function recoverPausedOnAwaken () {
  var currentAppId = this.runtime.life.getCurrentAppId()

  logger.info('unmute possibly paused bluetooth player')
  this.bluetoothPlayer && this.bluetoothPlayer.resume()

  logger.info('trying to resume previously awaken paused tts/media', currentAppId)
  return Promise.all([
    this.runtime.ttsMethod('resetAwaken', [ currentAppId ]),
    this.runtime.multimediaMethod('resetAwaken', [ currentAppId ])
  ])
}

/**
 * Handle the "voice coming" event.
 * @private
 */
Turen.prototype.handleVoiceComing = function handleVoiceComing (data) {
  if (!this.runtime.custodian.isPrepared()) {
    logger.warn('Network not connected, preparing to announce unavailability.')
    this.pickup(false)

    var currentAppId = this.runtime.life.getCurrentAppId()
    if (this.runtime.custodian.isConfiguringNetwork()) {
      /**
       * Configuring network, delegates event to network app.
       */
      logger.info('configuring network, renewing timer.')
      return this.runtime.openUrl('yoda-skill://network/renew')
    }

    if (wifi.getNumOfHistory() === 0) {
      if (currentAppId) {
        /**
         * although there is no WiFi history, yet some app is running out there,
         * continuing currently app.
         */
        logger.info('no WiFi history exists, continuing currently running app.')
        return this.runtime.light.ttsSound('@yoda', 'system://guide_config_network.ogg')
          .then(() =>
          /** awaken is not set for no network available, recover media directly */
            this.recoverPausedOnAwaken()
          )
      }
      /**
       * No WiFi connection history found, introduce device setup procedure.
       */
      logger.info('no WiFi history exists, preparing network configuration.')
      return this.runtime.openUrl('yoda-skill://network/setup')
    }

    /**
     * if runtime is logging in or network is unavailable,
     * and there is WiFi history existing,
     * announce WiFi is connecting.
     */
    logger.info('announcing network connecting on voice coming.')
    wifi.enableScanPassively()
    return this.runtime.light.ttsSound('@yoda', 'system://wifi_is_connecting.ogg')
      .then(() =>
        /** awaken is not set for no network available, recover media directly */
        this.recoverPausedOnAwaken()
      )
  }

  var future = this.setAwaken()
  clearTimeout(this.solitaryVoiceComingTimer)
  this.solitaryVoiceComingTimer = setTimeout(() => {
    logger.warn('detected a solitary voice coming, resetting awaken')
    this.pickup(false)
    this.resetAwaken()
  }, this.solitaryVoiceComingTimeout)

  if (this.runtime.forceUpdateAvailable) {
    future.then(
      () => this.runtime.startForceUpdate(),
      err => {
        logger.error('unexpected error on set awaken', err.stack)
        return this.runtime.startForceUpdate()
      }
    )
  }

  /**
   * reset picking up discarding state to enable next nlp process
   */
  this.pickingUpDiscardNext = false

  return future
}

/**
 * Handle the "voice local awake" event.
 * @private
 */
Turen.prototype.handleVoiceLocalAwake = function handleVoiceLocalAwake (data) {
  /**
   * Nothing to do in local_awake event.
   */
}

/**
 * Handle the "asr pending" event.
 * @private
 */
Turen.prototype.handleAsrPending = function handleAsrPending () {
  this.asrState = 'pending'
  clearTimeout(this.solitaryVoiceComingTimer)

  clearTimeout(this.noVoiceInputTimer)
  this.noVoiceInputTimer = setTimeout(() => {
    logger.warn('no more voice input detected, closing pickup')
    this.pickup(false)
  }, this.noVoiceInputTimeout)
}

/**
 * Handle the "asr end" event.
 * @private
 */
Turen.prototype.handleAsrEnd = function handleAsrEnd () {
  this.asrState = 'end'
  clearTimeout(this.noVoiceInputTimer)

  var promises = [
    this.resetAwaken({
      recover: /** no recovery shall be made on nlp coming */ false
    })
  ]

  if (this.pickingUpDiscardNext) {
    /**
     * current session of picking up has been manually discarded,
     * no loading state shall be presented.
     */
    return Promise.all(promises)
  }
  return Promise.all(promises.concat(this.runtime.light.play('@yoda', 'system://loading.js')))
}

/**
 * Handle the "asr fake" event.
 * @private
 */
Turen.prototype.handleAsrFake = function handleAsrFake () {
  this.asrState = 'fake'
  clearTimeout(this.noVoiceInputTimer)

  return this.resetAwaken()
}

/**
 * Handle the "start voice" event.
 * @private
 */
Turen.prototype.handleStartVoice = function handleStartVoice () {
  this.pickingUp = true
}

/**
 * Handle the "end voice" event.
 * @private
 */
Turen.prototype.handleEndVoice = function handleEndVoice () {
  this.pickingUp = false
  logger.info('on end of voice, asr:', this.asrState)
  if (this.asrState === 'end') {
    return
  }
  if (this.awaken) {
    return this.resetAwaken()
  }
}

/**
 * Handle the "nlp" event.
 * @private
 */
Turen.prototype.handleNlpResult = function handleNlpResult (data) {
  if (this.pickingUpDiscardNext) {
    /**
     * current session of picking up has been manually discarded.
     */
    this.pickingUpDiscardNext = false
    logger.warn(`discarding nlp for pick up discarded, ASR(${_.get(data, 'nlp.asr')}).`)
    return
  }
  if (this.runtime.sound.isMuted() && !this.runtime.sound.isVolumeNlp(data.nlp)) {
    /**
     * Unmute speaker volume if it's muted and ongoing nlp is not
     * volume app (which depends on state of speaker).
     */
    this.runtime.sound.unmute()
  }
  var future
  if (this.awaken) {
    future = this.resetAwaken({
      recover: /** no recovery shall be made on nlp coming */ false
    })
  } else {
    future = Promise.resolve()
  }
  return future.then(() => this.runtime.onVoiceCommand(data.asr, data.nlp, data.action))
    .then(success => {
      this.runtime.light.stop('@yoda', 'system://loading.js')
      if (success) {
        return
      }
      /**
       * try to recover paused tts/media on awaken in case of
       * failed to handle incoming nlp request.
       */
      this.recoverPausedOnAwaken()
    }, err => {
      this.runtime.light.stop('@yoda', 'system://loading.js')
      logger.error('Unexpected error on open handling nlp', err.stack)
    })
}

/**
 * Handle the "nlp" event, which are emitted on incoming unexpected malicious nlp.
 */
Turen.prototype.handleMaliciousNlpResult = function handleMaliciousNlpResult () {
  if (this.awaken) {
    /**
     * if malicious nlp happened before 'asr end'/'end voice',
     * recover multimedia playing state directly,
     * no system exception procedure needed to be processed.
     */
    return this.resetAwaken()
  }
  if (!this.runtime.custodian.isPrepared()) {
    // Do noting when network is not ready
    logger.warn('Network not connected, skip malicious nlp result')
    return
  }
  this.runtime.openUrl('yoda-skill://rokid-exception/malicious-nlp')
    .then(
      () => this.runtime.light.stop('@yoda', 'system://loading.js'),
      err => {
        this.runtime.light.stop('@yoda', 'system://loading.js')
        logger.error('Unexpected error on open handling malicious nlp', err.stack)
      })
}

/**
 * Handle 'speech error' events, which are emitted on unexpected speech faults.
 */
Turen.prototype.handleSpeechError = function handleSpeechError (errCode) {
  if (this.awaken) {
    /**
     * if speech error happened before 'asr end'/'end voice',
     * recover multimedia playing state directly,
     * no system exception procedure needed to be processed.
     */
    return this.resetAwaken()
  }
  if (!this.runtime.custodian.isPrepared()) {
    // Do noting when network is not ready
    logger.warn('Network not connected or not logged in, skip speech error')
    return
  }

  if (errCode >= 100) {
    /** network error */
    return this.runtime.light.lightMethod('networkLagSound', [ '/opt/media/network_lag_common.ogg' ])
      .then(
        () => this.recoverPausedOnAwaken(),
        err => {
          logger.error('Unexpected error on playing network lag sound', err.stack)
          return this.recoverPausedOnAwaken()
        }
      )
  }

  this.runtime.openUrl(`yoda-skill://rokid-exception/speech-error?errCode=${errCode}`)
    .then(
      () => this.runtime.light.stop('@yoda', 'system://loading.js'),
      err => {
        this.runtime.light.stop('@yoda', 'system://loading.js')
        logger.error('Unexpected error on open handling speech error', err.stack)
      })
}

/**
 * Set whether or not turenproc is picked up.
 * @param {boolean} isPickup
 */
Turen.prototype.pickup = function pickup (isPickup) {
  /**
   * if set not to picking up, discard next coming nlp,
   * otherwise reset picking up discarding state to enable next nlp process,
   */
  this.pickingUpDiscardNext = !isPickup

  var msg = new Caps()
  msg.writeInt32(isPickup ? 1 : 0)
  this.runtime.flora.post('rokid.turen.pickup', msg)
}

/**
 * Set whether or not turenproc is muted. By default toggles mute.
 * @param {boolean} [mute]
 */
Turen.prototype.toggleMute = function toggleMute (mute) {
  if (mute == null) {
    mute = !this.muted
  }
  this.muted = mute
  var msg = new Caps()
  /** if mute is true, set rokid.turen.mute to 1 to disable turen */
  msg.writeInt32(mute ? 1 : 0)
  this.runtime.flora.post('rokid.turen.mute', msg)

  if (this.asrState === 'pending' && mute) {
    this.resetAwaken()
  }

  return this.muted
}

/**
 * Add an activation word.
 * @param {string} activationTxt
 * @param {string} activationPy
 */
Turen.prototype.addVtWord = function addVtWord (activationWord, activationPy) {
  var caps = new Caps()
  caps.write(activationWord)
  caps.write(activationPy)
  caps.writeInt32(1)
  this.runtime.flora.post(VT_WORDS_ADD_WORD_CHANNEL, caps)
}

/**
 * Delete an activation word
 * @param {string} activationTxt
 */
Turen.prototype.deleteVtWord = function deleteVtWord (activationWord) {
  var caps = new Caps()
  caps.write(activationWord)
  this.runtime.flora.post(VT_WORDS_DEL_WORD_CHANNEL, caps)
}

/**
 * Set a flag which informs startup service that it is time to boot turenproc.
 */
Turen.prototype.setTurenStartupFlag = function setTurenStartupFlag () {
  return new Promise((resolve, reject) => {
    /**
     * intended typo: bootts
     */
    fs.writeFile('/tmp/.com.rokid.activation.bootts', '', err => {
      if (err) {
        return reject(err)
      }
      resolve()
    })
  })
}
