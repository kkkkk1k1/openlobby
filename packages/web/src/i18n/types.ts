export type Locale = 'zh-CN' | 'en';

export type TranslationParams = Record<string, string | number | null | undefined>;

export interface Messages {
  'common.add': string;
  'common.allow': string;
  'common.cancel': string;
  'common.close': string;
  'common.confirm': string;
  'common.copy': string;
  'common.copied': string;
  'common.delete': string;
  'common.deny': string;
  'common.dismiss': string;
  'common.import': string;
  'common.language': string;
  'common.light': string;
  'common.dark': string;
  'common.other': string;
  'common.remove': string;
  'common.retry': string;
  'common.send': string;
  'common.settings': string;
  'common.stop': string;
  'common.system': string;
  'common.theme': string;
  'common.accountId': string;
  'common.im': string;
  'common.terminal': string;
  'common.optional': string;

  'time.justNow': string;
  'time.minutesAgo': string;
  'time.hoursAgo': string;
  'time.daysAgo': string;

  'app.sessionErrored': string;
  'app.sessionStopped': string;
  'app.recoverToIdle': string;
  'app.emptyStateTitle': string;
  'app.emptyStateHint': string;
  'app.sessionEndedHint': string;

  'sidebar.importCliSessions': string;
  'sidebar.empty': string;
  'sidebar.rename': string;
  'sidebar.pinToTop': string;
  'sidebar.unpin': string;
  'sidebar.approval': string;
  'sidebar.openLobbyManagerSession': string;
  'sidebar.noCliAdapterAvailable': string;
  'sidebar.lobbyManager': string;
  'sidebar.imChannels': string;
  'sidebar.themeTitle': string;
  'sidebar.toggleLanguage': string;
  'sidebar.statusRunning': string;
  'sidebar.statusNeedsApproval': string;
  'sidebar.statusIdle': string;
  'sidebar.statusStopped': string;
  'sidebar.statusError': string;

  'roomHeader.auto': string;
  'roomHeader.supervised': string;
  'roomHeader.readonly': string;
  'roomHeader.default': string;
  'roomHeader.permissionMapsTo': string;
  'roomHeader.openInTerminal': string;
  'roomHeader.openInTerminalTitle': string;
  'roomHeader.cwd': string;
  'roomHeader.sessionId': string;
  'roomHeader.model': string;
  'roomHeader.modelPlaceholder': string;
  'roomHeader.permissionMode': string;
  'roomHeader.messageMode': string;
  'roomHeader.useGlobalDefault': string;
  'roomHeader.applyNextMessage': string;
  'roomHeader.removeSession': string;
  'roomHeader.removeSessionTitle': string;
  'roomHeader.removeSessionBody': string;
  'roomHeader.removeSessionKeepHistory': string;
  'roomHeader.terminalAutoOpenFailed': string;
  'roomHeader.runCommandManually': string;
  'roomHeader.copyCommand': string;

  'messageMode.tidy': string;
  'messageMode.only': string;
  'messageMode.total': string;

  'messageList.empty': string;
  'messageList.newMessages': string;

  'messageInput.fileTooLarge': string;
  'messageInput.uploadFailed': string;
  'messageInput.dropFilesHere': string;
  'messageInput.planModePlaceholder': string;
  'messageInput.messagePlaceholder': string;
  'messageInput.attachFile': string;
  'messageInput.dropToAttach': string;

  'slashMenu.help': string;
  'slashMenu.listSessions': string;
  'slashMenu.createSession': string;
  'slashMenu.gotoSession': string;
  'slashMenu.returnLobbyManager': string;
  'slashMenu.interruptReply': string;
  'slashMenu.rebuildCli': string;
  'slashMenu.destroySession': string;
  'slashMenu.planMode': string;
  'slashMenu.commandsCount': string;
  'slashMenu.updating': string;

  'controlCard.approvalRequired': string;

  'choiceCard.selectContinue': string;
  'choiceCard.selected': string;

  'questionCard.title': string;
  'questionCard.multiSelect': string;
  'questionCard.otherPlaceholder': string;
  'questionCard.answersSubmitted': string;

  'toolSummary.processing': string;
  'toolSummary.lastPreview': string;

  'messageBubble.renderError': string;
  'messageBubble.unknownTool': string;
  'messageBubble.error': string;
  'messageBubble.expand': string;
  'messageBubble.collapse': string;
  'messageBubble.showLess': string;
  'messageBubble.showAll': string;
  'messageBubble.tokens': string;
  'messageBubble.contextLimit': string;
  'messageBubble.compactNow': string;
  'messageBubble.compacting': string;
  'messageBubble.compacted': string;
  'messageBubble.compactedWas': string;

  'discover.title': string;
  'discover.subtitle': string;
  'discover.all': string;
  'discover.noSessions': string;
  'discover.noFilterMatches': string;
  'discover.selectAll': string;
  'discover.selected': string;
  'discover.importing': string;
  'discover.alreadyImported': string;

  'newSession.title': string;
  'newSession.agent': string;
  'newSession.name': string;
  'newSession.workingDirectory': string;
  'newSession.initialPrompt': string;
  'newSession.initialPromptPlaceholder': string;
  'newSession.advancedShow': string;
  'newSession.advancedHide': string;
  'newSession.systemPrompt': string;
  'newSession.systemPromptPlaceholder': string;
  'newSession.namePlaceholder': string;
  'newSession.cwdPlaceholder': string;
  'newSession.modelPlaceholderClaude': string;
  'newSession.modelPlaceholderCodex': string;
  'newSession.modelPlaceholderOpenCode': string;
  'newSession.modelPlaceholderGsd': string;
  'newSession.createRoom': string;

  'globalSettings.title': string;
  'globalSettings.defaultAdapter': string;
  'globalSettings.defaultAdapterHelp': string;
  'globalSettings.defaultMessageMode': string;
  'globalSettings.defaultViewMode': string;
  'globalSettings.imChatBubbles': string;
  'globalSettings.defaultNewSessions': string;
  'globalSettings.defaultPermissionModes': string;
  'globalSettings.confirmAdapterSwitchTitle': string;
  'globalSettings.confirmAdapterSwitchBody': string;
  'globalSettings.localeZhCn': string;
  'globalSettings.localeEn': string;

  'channelManage.title': string;
  'channelManage.providersTab': string;
  'channelManage.bindingsTab': string;
  'channelManage.noProviders': string;
  'channelManage.noBindings': string;
  'channelManage.providerOn': string;
  'channelManage.providerOff': string;
  'channelManage.addProvider': string;
  'channelManage.addWecomScan': string;
  'channelManage.generateQr': string;
  'channelManage.generatingQr': string;
  'channelManage.scanWithWecom': string;
  'channelManage.qrExpired': string;
  'channelManage.regenerate': string;
  'channelManage.unknownError': string;
  'channelManage.scanSuccess': string;
  'channelManage.manualInput': string;
  'channelManage.channelType': string;
  'channelManage.backToQr': string;
  'channelManage.target': string;
  'channelManage.unbind': string;
  'channelManage.wecomOption': string;
  'channelManage.telegramOption': string;
  'channelManage.fieldBotId': string;
  'channelManage.fieldSecret': string;
  'channelManage.fieldBotToken': string;
  'channelManage.fieldWebhookUrl': string;
  'channelManage.fieldWebhookSecret': string;
  'channelManage.accountIdPlaceholder': string;
  'channelManage.wecomQrAlt': string;
}

export type MessageKey = keyof Messages;
