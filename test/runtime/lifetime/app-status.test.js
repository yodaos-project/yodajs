var test = require('tape')
var _ = require('@yoda/util')._

var helper = require('../../helper')
var Lifetime = require(`${helper.paths.runtime}/lib/lifetime`)
var mock = require('./mock')

test('is daemon app', t => {
  var apps = mock.getMockAppExecutors(1)
  var daemonApps = mock.getMockAppExecutors(1, true, 1)
  var life = new Lifetime(Object.assign(apps, daemonApps))

  t.strictEqual(life.isDaemonApp('0'), false)
  t.strictEqual(life.isDaemonApp('1'), true)

  life.createApp('1')
    .then(() => {
      t.strictEqual(life.isAppRunning('1'), true, 'app shall be running on created')
      t.strictEqual(life.isAppInStack('1'), false)
      t.strictEqual(life.isAppInactive('1'), false)
      t.strictEqual(life.isBackgroundApp('1'), true)
      return life.activateAppById('1')
    })
    .then(() => {
      t.strictEqual(life.isAppRunning('1'), true)
      t.strictEqual(life.isAppInStack('1'), true, 'app shall be top of stack on activated')
      t.strictEqual(life.isAppInactive('1'), false)
      t.strictEqual(life.isBackgroundApp('1'), false)
      return life.deactivateAppById('1')
    })
    .then(() => {
      t.strictEqual(life.isAppRunning('1'), true)
      t.strictEqual(life.isAppInStack('1'), false)
      t.strictEqual(life.isAppInactive('1'), false)
      t.strictEqual(life.isBackgroundApp('1'), true, 'daemon app shall be in background on deactivated')
      return life.activateAppById('1').then(() => life.setBackgroundById('1'))
    })
    .then(() => {
      t.strictEqual(life.isAppRunning('1'), true)
      t.strictEqual(life.isAppInStack('1'), false)
      t.strictEqual(life.isAppInactive('1'), false)
      t.strictEqual(life.isBackgroundApp('1'), true, 'app shall be in background on set background')
      return life.destroyAppById('1')
    })
    .then(() => {
      t.strictEqual(life.isAppRunning('1'), false, 'daemon app shall be not be running on destroyed')
      t.strictEqual(life.isAppInStack('1'), false)
      t.strictEqual(life.isAppInactive('1'), false)
      t.strictEqual(life.isBackgroundApp('1'), false)
      t.end()
    })
    .catch(err => {
      t.error(err)
      t.end()
    })
})

test('current app status', t => {
  mock.restore()

  var apps = mock.getMockAppExecutors(5)
  var life = new Lifetime(apps)

  t.strictEqual(life.isDaemonApp('1'), false)
  t.strictEqual(life.isAppRunning('1'), false)

  life.createApp('1')
    .then(() => {
      t.looseEqual(life.getCurrentAppId(), undefined, 'should have no current app')
      t.strictEqual(life.isAppRunning('1'), true, 'shall be running')
      t.strictEqual(life.isAppInactive('1'), true, 'shall be inactive once created')
      t.strictEqual(life.isAppInStack('1'), false, 'shall not be in stack once created')
      t.strictEqual(life.isBackgroundApp('1'), false, 'should not be background app once created')
      return life.activateAppById('1')
    })
    .then(() => {
      t.strictEqual(life.getCurrentAppId(), '1', 'should be top of stack on activated')
      t.strictEqual(life.isAppRunning('1'), true, 'should be running after activated')
      t.strictEqual(life.isAppInStack('1'), true, 'should be in stack on activated')
      t.strictEqual(life.isAppInactive('1'), false, 'should not be inactive on activated')
      t.strictEqual(life.isBackgroundApp('1'), false, 'should not be background app on activated')
      t.deepEqual(life.getCurrentAppData(), { form: 'cut' })
      return life.deactivateAppById('1')
    })
    .then(() => {
      t.strictEqual(life.getCurrentAppId(), undefined)
      t.strictEqual(life.isAppRunning('1'), false, 'app is not daemon, deactivating shall destroy it')
      t.strictEqual(life.isAppInStack('1'), false)
      t.strictEqual(life.isAppInactive('1'), false, 'app is not daemon, deactivating shall destroy it')
      t.strictEqual(life.isBackgroundApp('1'), false)

      return life.createApp('1')
        .then(() => life.activateAppById('1'))
        .then(() => life.setBackgroundById('1'))
    })
    .then(() => {
      t.strictEqual(life.isAppRunning('1'), true)
      t.strictEqual(life.isAppInStack('1'), false)
      t.strictEqual(life.isAppInactive('1'), false)
      t.strictEqual(life.isBackgroundApp('1'), true, 'normal app shall be in background on set background')
      return life.destroyAppById('1')
    })
    .then(() => {
      t.strictEqual(life.isAppRunning('1'), false, 'app shall be not be running on destroyed')
      t.strictEqual(life.isAppInStack('1'), false)
      t.strictEqual(life.isAppInactive('1'), false)
      t.strictEqual(life.isBackgroundApp('1'), false)
      t.end()
    })
    .catch(err => {
      t.error(err)
      t.end()
    })
})

test('should get app data by id', t => {
  mock.restore()

  var apps = mock.getMockAppExecutors(5)
  var life = new Lifetime(apps)

  Promise.all(_.times(5).map(idx => life.createApp(`${idx}`)))
    .then(() => {
      return _.mapSeries(_.times(5), idx =>
        life.activateAppById(`${idx}`)
          .then(() => {
            t.deepEqual(life.getAppDataById(`${idx}`), { form: 'cut' })
          })
      )
    })
    .then(() => {
      t.end()
    })
    .catch(err => {
      t.error(err)
      t.end()
    })
})
