const LoginWithTwitter = require('login-with-twitter')
const LFM = require('lastfm-node-client')
const chalk = require('chalk')
const Twit = require('twit')
const auth = require('../middleware/auth.js')
const User = require('../db/schemas/User.js')
const express = require('express')
const router = express.Router()
const { MiscUtils, crypto } = require('../utils')

const LastFM = new LFM(process.env.LASTFM_KEY, process.env.LASTFM_SECRET)

const TW = new LoginWithTwitter({
  consumerKey: process.env.TWITTER_API_KEY,
  consumerSecret: process.env.TWITTER_API_SECRET,
  callbackUrl: process.env.API_URL + 'auth/twitter/callback'
})

const twitterSecretTokens = new Map()

module.exports = (musicorum) => {
  router.get('/me', auth, async (req, res) => {
    try {
      const { user } = req
      const T = new Twit({
        consumer_key: process.env.TWITTER_API_KEY,
        consumer_secret: process.env.TWITTER_API_SECRET,
        access_token: crypto.decryptToken(user.twitter.accessToken, process.env.TWITTER_CRYPTO),
        access_token_secret: crypto.decryptToken(user.twitter.accessSecret, process.env.TWITTER_CRYPTO)
      })
      const { data } = await T.get('account/verify_credentials', { skip_status: true })
      console.log(user)
      const twitter = {
        id: data.id_str,
        name: data.name,
        user: data.screen_name,
        profilePicture: data.profile_image_url_https.replace('_normal', '')
      }
      let lastfm = null
      if (user.lastfm && user.lastfm.sessionKey) {
        const sk = crypto.decryptToken(user.lastfm.sessionKey, process.env.LASTFM_CRYPTO)
        const lfm = new LFM(process.env.LASTFM_KEY, process.env.LASTFM_SECRET, sk)
        const userInfo = await lfm.userGetInfo()
        const { image } = userInfo.user
        lastfm = {
          user: userInfo.user.name,
          name: userInfo.user.realname,
          profilePicture: image[image.length - 1]['#text']
        }
      }
      res.json({
        id: user._id,
        twitter,
        lastfm
      })
    } catch (err) {
      res
        .status(500)
        .json({ message: 'Internal server error.' })
      console.error(chalk.bgRed(' ERROR ') + ' ' + err)
      console.error(err)
    }
  })

  router.get('/twitter', async (req, res) => {
    TW.login((err, tokenSecret, url) => {
      if (err) {
        res
          .status(500)
          .json({ message: 'Internal server error.' })
        console.error(chalk.bgRed(' ERROR ') + ' ' + err)
        console.error(err)
        return
      }

      const tokenId = MiscUtils.generateRandomString(16)
      twitterSecretTokens.set(tokenId, tokenSecret)

      res.json({ url, tokenId })
    })
  })

  router.post('/twitter/callback', async (req, res) => {
    const { oauthToken, oauthVerifier, tokenId } = req.body
    if (!oauthToken || !oauthVerifier || !tokenId) {
      res
        .status(400)
        .json({ message: 'Missing parameters.' })
      return
    }
    const secret = twitterSecretTokens.get(tokenId)
    if (!secret) {
      res
        .status(400)
        .json({ message: 'Invalid tokenId' })
      return
    }
    TW.callback({ oauth_token: oauthToken, oauth_verifier: oauthVerifier }, secret, async (err, user) => {
      if (err) {
        res
          .status(500)
          .json({ message: 'Internal server error.' })
        console.error(chalk.bgRed(' ERROR ') + ' ' + err)
        console.error(err)
        return
      }

      const userDoc = await User.findOne({ 'twitter.id': user.userId })

      console.log(userDoc)
      if (userDoc) {
        res
          .status(200)
          .json({
            token: userDoc.generateAuthToken()
          })
      } else {
        const twitterAcc = new User.TwitterAccount({
          accessToken: crypto.encryptToken(user.userToken, process.env.TWITTER_CRYPTO),
          accessSecret: crypto.encryptToken(user.userTokenSecret, process.env.TWITTER_CRYPTO),
          id: user.userId
        })
        const newUser = new User({
          twitter: twitterAcc
        })
        newUser.save()
        res
          .status(200)
          .json({
            token: newUser.generateAuthToken()
          })
      }

      twitterSecretTokens.delete(tokenId)
    })
  })

  router.post('/lastfm/callback', auth, async (req, res) => {
    try {
      const { token } = req.body
      if (!token) {
        res
          .status(400)
          .json({ message: 'Missing token.' })
        return
      }
      const { session } = await LastFM.authGetSession({ token })
      console.log(session)

      res.json({ user: session.name })

      const lfmInfo = new User.LastfmAccount({
        sessionKey: crypto.encryptToken(session.key, process.env.LASTFM_CRYPTO)
      })

      req.user.lastfm = lfmInfo
      req.user.save()
    } catch (err) {
      res
        .status(500)
        .json({ message: err.message })
      console.error(chalk.bgRed(' ERROR ') + ' ' + err)
      console.error(err)
    }
  })

  return router
}
