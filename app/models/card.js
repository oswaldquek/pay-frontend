'use strict'

// NPM dependencies
const _ = require('lodash')
const q = require('q')
const changeCase = require('change-case')
const logger = require('winston')
const AWSXRay = require('aws-xray-sdk')
const {getNamespace} = require('continuation-local-storage')
const i18n = require('i18n')

// Local dependencies
const cardIdClient = require('../utils/cardid_client')

// Constants
const clsXrayConfig = require('../../config/xray-cls')
const i18nConfig = require('../../config/i18n')

i18n.configure(i18nConfig)

const checkCard = function (cardNo, allowed, language, correlationId, subSegment) {
  const defer = q.defer()
  const startTime = new Date()
  const data = {'cardNumber': parseInt(cardNo)}

  i18n.setLocale(language || 'en')

  // Use a subSegment if passed, otherwise get our main segment
  if (!subSegment) {
    const namespace = getNamespace(clsXrayConfig.nameSpaceName)
    subSegment = namespace.get(clsXrayConfig.segmentKeyName)
  }

  AWSXRay.captureAsyncFunc('cardIdClient_post', function (postSubsegment) {
    cardIdClient.post({data: data, correlationId: correlationId}, function (data, response) {
      postSubsegment.close()
      logger.info(`[${correlationId}]  - %s to %s ended - total time %dms`, 'POST', cardIdClient.CARD_URL, new Date() - startTime)

      if (response.statusCode === 404) {
        return defer.reject('Your card is not supported')
      }
      // if the server is down, or returns non 500, just continue
      if (response.statusCode !== 200) {
        return defer.resolve()
      }

      const card = {
        brand: changeCase.paramCase(data.brand),
        type: normaliseCardType(data.type),
        corporate: data.corporate
      }

      logger.debug(`[${correlationId}] Checking card brand - `, {'cardBrand': card.brand, 'cardType': card.type})

      if (_.filter(allowed, {brand: card.brand}).length === 0) {
        defer.reject(i18n.__('fieldErrors.fields.cardNo.unsupportedBrand', changeCase.titleCase(card.brand)))
      }

      if (!_.find(allowed, {brand: card.brand, type: card.type})) {
        switch (card.type) {
          case 'DEBIT':
            return defer.reject(i18n.__('fieldErrors.fields.cardNo.unsupportedDebitCard', changeCase.titleCase(card.brand)))
          case 'CREDIT':
            return defer.reject(i18n.__('fieldErrors.fields.cardNo.unsupportedCreditCard', changeCase.titleCase(card.brand)))
        }
      }

      return defer.resolve(card)
    }, postSubsegment).on('error', function (error) {
      postSubsegment.close(error)
      logger.error(`[${correlationId}] ERROR CALLING CARDID AT ${cardIdClient.CARD_URL}`, error)
      logger.info(`[${correlationId}] - %s to %s ended - total time %dms`, 'POST', cardIdClient.cardUrl, new Date() - startTime)
      defer.resolve()
    })
  }, subSegment)
  return defer.promise
}

const normaliseCardType = function (cardType) {
  switch (cardType) {
    case 'D':
      return 'DEBIT'
    case 'C':
      return 'CREDIT'
    case 'CD':
      return 'CREDIT_OR_DEBIT'
  }
  return undefined
}

module.exports = function (allowedCards, correlationId) {
  const withdrawalTypes = []
  const allowed = _.clone(allowedCards)
  correlationId = correlationId || ''

  if (_.filter(allowedCards, {debit: true}).length !== 0) withdrawalTypes.push('debit')
  if (_.filter(allowedCards, {credit: true}).length !== 0) withdrawalTypes.push('credit')

  return {
    withdrawalTypes: withdrawalTypes,
    allowed: _.clone(allowed),
    checkCard: (cardNo, language, subSegment) => {
      return checkCard(cardNo, allowed, language, correlationId, subSegment)
    }
  }
}
