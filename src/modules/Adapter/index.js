import moduleStatuses from 'ringcentral-integration/enums/moduleStatuses';
import telephonyStatuses from 'ringcentral-integration/enums/telephonyStatuses';
import terminationTypes from 'ringcentral-integration/enums/terminationTypes';
import ensureExist from 'ringcentral-integration/lib/ensureExist';
import normalizeNumber from 'ringcentral-integration/lib/normalizeNumber';
import { isRing } from 'ringcentral-integration/modules/Webphone/webphoneHelper';
import { Module } from 'ringcentral-integration/lib/di';

import AdapterModuleCore from 'ringcentral-widgets/lib/AdapterModuleCore';

import messageTypes from '../../lib/Adapter/messageTypes';
import actionTypes from './actionTypes';
import getReducer from './getReducer';

@Module({
  deps: [
    'Auth',
    'RouterInteraction',
    'DetailedPresence',
    'ComposeText',
    'Call',
    'DialerUI',
    'Webphone',
    'RegionSettings',
    'GlobalStorage',
    'Locale',
    { dep: 'AdapterOptions', optional: true }
  ]
})
export default class Adapter extends AdapterModuleCore {
  constructor({
    auth,
    detailedPresence,
    composeText,
    call,
    dialerUI,
    webphone,
    regionSettings,
    stylesUri,
    prefix,
    ...options,
  }) {
    super({
      ...options,
      prefix,
      actionTypes,
      messageTypes,
      presence: detailedPresence,
      storageKey: 'adapterData',
      webphone,
    });
    this._messageTypes = messageTypes;
    this._auth = this::ensureExist(auth, 'auth');
    this._presence = this::ensureExist(detailedPresence, 'detailedPresence');
    this._composeText = this::ensureExist(composeText, 'composeText');
    this._webphone = this::ensureExist(webphone, 'webphone');
    this._regionSettings = this::ensureExist(regionSettings, 'regionSettings');
    this._call = this::ensureExist(call, 'call');
    this._dialerUI = this::ensureExist(dialerUI, 'dialerUI');
    this._reducer = getReducer(this.actionTypes);
    this._callSessions = new Map();
    this._stylesUri = stylesUri;
    this._loggedIn = false;
    this._lastActiveCalls = [];
    this._lastEndedActiveCallMap = {};
  }

  initialize() {
    window.addEventListener('message', event => this._onMessage(event));
    this._insertExtendStyle();
    this.store.subscribe(() => this._onStateChange());
  }

  _onStateChange() {
    if (this._shouldInit()) {
      this.store.dispatch({
        type: this.actionTypes.init,
      });
      this._pushAdapterState();
      this.store.dispatch({
        type: this.actionTypes.initSuccess,
      });
    }
    this._pushPresence();
    this._pushLocale();
    this._checkLoginStatus();
    this._pushActiveCall();
  }

  _onMessage(event) {
    const data = event.data;
    if (data) {
      switch (data.type) {
        case 'rc-adapter-set-environment':
          if (window.toggleEnv) {
            window.toggleEnv();
          }
          break;
        case 'rc-adapter-new-sms':
          this._newSMS(data.phoneNumber);
          break;
        case 'rc-adapter-new-call':
          this._newCall(data.phoneNumber, data.toCall);
          break;
        case 'rc-adapter-control-call':
          this._controlCall(data.callAction, data.callId);
          break;
        case 'rc-adapter-logout':
          if (this._auth.loggedIn) {
            this._auth.logout();
          }
          break;
        default:
          super._onMessage(data);
          break;
      }
    }
  }

  _pushAdapterState() {
    this._postMessage({
      type: this._messageTypes.pushAdapterState,
      size: this.size,
      minimized: this.minimized,
      closed: this.closed,
      position: this.position,
      telephonyStatus: (this._auth.loggedIn && this._presence.telephonyStatus) || null,
      userStatus: (this._auth.loggedIn && this._presence.userStatus) || null,
      dndStatus: (this._auth.loggedIn && this._presence.dndStatus) || null,
    });
  }

  _pushPresence() {
    if (
      this.ready &&
      (
        this._lastDndStatus !== this._presence.dndStatus ||
        this._lastUserStatus !== this._presence.userStatus ||
        this._lastTelephonyStatus !== this._presence.telephonyStatus
      )
    ) {
      this._lastDndStatus = this._presence.dndStatus;
      this._lastUserStatus = this._presence.userStatus;
      this._lastTelephonyStatus = this._presence.telephonyStatus;
      this._postMessage({
        type: this._messageTypes.syncPresence,
        telephonyStatus: (this._auth.loggedIn && this._presence.telephonyStatus) || null,
        userStatus: (this._auth.loggedIn && this._presence.userStatus) || null,
        dndStatus: (this._auth.loggedIn && this._presence.dndStatus) || null,
      });
    }
  }

  _pushActiveCall() {
    if (this._lastActiveCalls === this._presence.calls) {
      return;
    }
    const lastActiveCallsMap = {};
    this._lastActiveCalls.forEach((call) => {
      lastActiveCallsMap[`${call.sessionId}${call.direction}`] = call;
    });
    this._lastActiveCalls = this._presence.calls;
    const changedCalls = [];
    // Ended Call is not in this._presence.calls
    // So if one call existed in last calls and not existed in new calls, it is ended
    this._presence.calls.forEach((call) => {
      const oldCall = lastActiveCallsMap[`${call.sessionId}${call.direction}`];
      if (!oldCall) {
        changedCalls.push({ ...call });
        return;
      }
      if (
        oldCall.telephonyStatus !== call.telephonyStatus ||
        oldCall.terminationType !== call.terminationType
      ) {
        changedCalls.push({ ...call });
      }
      delete lastActiveCallsMap[`${call.sessionId}${call.direction}`];
    });
    const endedActiveCallMap = this._lastEndedActiveCallMap;
    this._lastEndedActiveCallMap = {};
    // add ended call
    Object.keys(lastActiveCallsMap).forEach((callId) => {
      const endedCall = lastActiveCallsMap[callId];
      this._lastEndedActiveCallMap[callId] = endedCall;
      if (endedActiveCallMap[callId]) {
        return;
      }
      const missed = (endedCall.telephonyStatus === telephonyStatuses.ringing);
      changedCalls.push({
        ...endedCall,
        telephonyStatus: telephonyStatuses.noCall,
        terminationType: terminationTypes.final,
        missed,
        endTime: missed ? null : Date.now(),
      });
    });
    changedCalls.forEach(({ sipData, id, ...call }) => {
      this._postMessage({
        type: 'rc-active-call-notify',
        call
      });
    });
  }

  _checkLoginStatus() {
    if (this._loggedIn === this._auth.loggedIn) {
      return;
    }
    this._loggedIn = this._auth.loggedIn;
    this._postMessage({
      type: 'rc-login-status-notify',
      loggedIn: this._loggedIn,
    });
  }

  _insertExtendStyle() {
    if (!this._stylesUri) {
      return;
    }
    const link = window.document.createElement('link');
    link.type = 'text/css';
    link.rel = 'stylesheet';
    link.href = this._stylesUri;
    window.document.head.appendChild(link);
  }

  ringCallNotify(session) {
    if (this._callSessions.has(session.id)) {
      return;
    }
    const call = { ...session };
    this._callSessions.set(session.id, call);
    this._postMessage({
      type: 'rc-call-ring-notify',
      call,
    });
  }

  startCallNotify(session) {
    if (this._callSessions.has(session.id)) {
      const lastSession = this._callSessions.get(session.id);
      if (!isRing(lastSession)) {
        return;
      }
    }
    const call = { ...session };
    this._callSessions.set(session.id, call);
    this._postMessage({
      type: 'rc-call-start-notify',
      call,
    });
  }

  endCallNotify(session) {
    if (!this._callSessions.has(session.id)) {
      return;
    }
    this._callSessions.delete(session.id);
    this._postMessage({
      type: 'rc-call-end-notify',
      call: {
        ...session,
        endTime: Date.now(),
      },
    });
  }

  _controlCall(action, id) {
    if (id && !this._callSessions.has(id)) {
      return;
    }
    switch (action) {
      case 'answer':
        this._webphone.answer(id || this._webphone.ringSessionId);
        break;
      case 'reject':
        this._webphone.reject(id || this._webphone.ringSessionId);
        break;
      case 'hangup':
        this._webphone.hangup(id || this._webphone.activeSessionId);
        break;
      default:
        break;
    }
  }

  _newSMS(phoneNumber) {
    if (!this._auth.loggedIn) {
      return;
    }
    this._router.push('/composeText');
    this._composeText.updateTypingToNumber(phoneNumber);
  }

  _newCall(phoneNumber, toCall = false) {
    if (!this._auth.loggedIn) {
      return;
    }
    if (!this._call.isIdle) {
      return;
    }
    const isCall = this._isCallOngoing(phoneNumber);
    if (isCall) {
      return;
    }
    this._router.push('/dialer');
    this._dialerUI.setToNumberField(phoneNumber);
    if (toCall) {
      this._dialerUI.call({ phoneNumber });
    }
  }

  _isCallOngoing(phoneNumber) {
    const countryCode = this._regionSettings.countryCode;
    const areaCode = this._regionSettings.areaCode;
    const normalizedNumber = normalizeNumber({ phoneNumber, countryCode, areaCode });
    return !!this._webphone.sessions.find(
      session => session.to === normalizedNumber
    );
  }

  // eslint-disable-next-line
  _postMessage(data) {
    if (window && window.parent) {
      window.parent.postMessage(data, '*');
    }
  }

  get ready() {
    return this.state.status === moduleStatuses.ready;
  }

  get pending() {
    return this.state.status === moduleStatuses.pending;
  }
}
