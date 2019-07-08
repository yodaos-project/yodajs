var AudioFocus = require('@yodaos/application').AudioFocus
var speechSynthesis = require('@yodaos/speech-synthesis').speechSynthesis
var MediaPlayer = require('@yoda/multimedia').MediaPlayer
var logger = require('logger')('player')

var constant = require('../constant')
var MultimediaStatusChannel = constant.MultimediaStatusChannel
var TtsStatusChannel = constant.TtsStatusChannel
var StatusCode = constant.StatusCode

module.exports = function Player (text, url, transient, sequential) {
  logger.info(`playing text(${text}) & url(${url}), transient(${transient}), sequential(${sequential})`)
  if (text == null && url == null) {
    return
  }
  var focus = new AudioFocus(transient ? AudioFocus.Type.TRANSIENT : AudioFocus.Type.DEFAULT)
  focus.resumeOnGain = true
  if (url) {
    focus.player = new MediaPlayer()
    focus.player.prepare(url)
    focus.player.on('playing', () => {
      this.agent.post(MultimediaStatusChannel, [ 0/** cloud-multimedia */, StatusCode.start ])
    })
    focus.player.on('playbackcomplete', () => {
      this.agent.post(MultimediaStatusChannel, [ 0/** cloud-multimedia */, StatusCode.end ])
      if (sequential || !speechSynthesis.speaking) {
        focus.abandon()
      }
    })
  }
  focus.onGain = () => {
    logger.info(`focus gain, transient? ${transient}, player? ${focus.player == null}, resumeOnGain? ${focus.resumeOnGain}`)
    if (text && focus.utter == null) {
      /** on first gain */
      focus.utter = speechSynthesis.speak(text)
        .on('start', () => {
          this.agent.post(TtsStatusChannel, [ StatusCode.start ])
          if (!sequential && focus.player != null) {
            focus.player.start()
          }
        })
        .on('cancel', () => {
          logger.info('on cancel')
          this.agent.post(TtsStatusChannel, [ StatusCode.cancel ])
        })
        .on('error', () => {
          logger.info('on error')
          this.agent.post(TtsStatusChannel, [ StatusCode.error ])
          focus.abandon()
        })
        .on('end', () => {
          logger.info('on end')
          this.agent.post(TtsStatusChannel, [ StatusCode.end ])

          if (sequential && focus.player) {
            focus.player.start()
            return
          }
          if (focus.player && focus.player.playing) {
            return
          }
          focus.abandon()
        })
    } else if (focus.resumeOnGain && focus.player != null) {
      focus.player.start()
    }

    focus.resumeOnGain = false
  }
  focus.onLoss = (transient) => {
    logger.info(`focus lost, transient? ${transient}, player? ${focus.player == null}`)
    if (focus.utter) {
      speechSynthesis.cancel()
    }
    if (!transient || focus.player == null) {
      focus.player && focus.player.stop()
      this.finishVoice(focus)
      return
    }
    if (!focus.player.playing) {
      return
    }
    focus.resumeOnGain = true
    focus.player.pause()
  }
  focus.pause = () => {
    logger.info(`pausing, transient? ${transient}, player? ${focus.player == null}, state? ${focus.state}`)
    if (transient) {
      focus.abandon()
      return
    }
    focus.resumeOnGain = false
    speechSynthesis.cancel()
    if (focus.player) {
      focus.player.pause()
    } else {
      focus.abandon()
    }
  }
  focus.resume = () => {
    logger.info(`resuming, transient? ${transient}, player? ${focus.player == null}, state? ${focus.state}`)
    if (transient) {
      return
    }
    if (focus.player == null) {
      return
    }
    if (focus.state === AudioFocus.State.ACTIVE) {
      focus.player.start()
      return
    }
    focus.resumeOnGain = true
    focus.request()
  }

  focus.request()
  return focus
}
