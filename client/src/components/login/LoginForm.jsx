import React, { useState } from 'react'
import { useLocation, useNavigate } from "react-router-dom";
import FormHeader from './FormHeader'
import getEnvironment from '../../getenvironment'
import { redirectTargetFrom } from '../../authRedirect'
import {
  Box,
  Button,
  HStack,
  Image,
  Input,
  Text,
  VStack,
  Flex,
  FormControl,
  FormLabel,
} from '@chakra-ui/react'

const LoginForm = () => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  // The captcha appears only when the server asks for it — after repeated
  // failures on this address, or while the whole install is under a burst of
  // them. A normal sign-in never sees this.
  const [captcha, setCaptcha] = useState(null)
  const [captchaAnswer, setCaptchaAnswer] = useState('')
  const apiUrl = getEnvironment()
  const navigate = useNavigate();
  const location = useLocation();
  const handleForgotPassword = () => {
    // Navigate to the current URL with an additional path segment
    navigate(`/forgot-password`);
  };

  const loadCaptcha = async () => {
    try {
      const response = await fetch(`${apiUrl}/auth/captcha`, { credentials: 'include' })
      if (!response.ok) throw new Error('challenge unavailable')
      const data = await response.json()
      setCaptcha({ token: data.token, svg: data.svg })
      setCaptchaAnswer('')
    } catch {
      // Leave whatever is on screen and say so rather than clearing the form:
      // a transient failure here must not look like the password was wrong.
      setMessage('Could not load the challenge image. Please try again.')
    }
  }

  const handleSubmit = async (e) => {
    setIsLoading(true)
    e.preventDefault()
    const userData = { email, password }
    if (captcha) {
      userData.captchaToken = captcha.token
      userData.captchaAnswer = captchaAnswer
    }

    try {
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(userData),
        credentials: 'include',
      })

      const responseData = await response.json()

      if (!response.ok) {
        setMessage(`Login failed: ${responseData.message}`);
        if (responseData.captchaRequired) {
          // A fresh image when the last one expired or was already spent; the
          // same one stays put after a simple typo, so the user is not made to
          // re-read a new one for a slip.
          if (!captcha || responseData.captchaStale) await loadCaptcha()
          else setCaptchaAnswer('')
        }
        return;
      }

      if (responseData.token) {
        localStorage.setItem('token', responseData.token)
      }

      setMessage(responseData.message);
      // A full load rather than a client-side navigation: the platform navbar
      // reads the session once on mount, so a router push would land on the
      // target with a stale "signed out" navbar that bounces straight back.
      window.location.href = redirectTargetFrom(location.search);
    } catch (error) {
      console.error('An error occurred', error)
      setMessage('An error occurred. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }
  return (
    <Flex
      flex={{
        base: '50%',
        lg: '30%',
      }}
      marginBlock={{ base: 10, md: 0 }}
      display='flex'
      flexDirection='column'
      paddingInline={{
        base: '1rem',
        md: '2rem',
      }}>
      <FormHeader />
      <form onSubmit={handleSubmit}>
        <VStack spacing={3} width='100%'>
          <FormControl>
            <FormLabel>Email</FormLabel>

            <Input
              type='email'
              placeholder='Enter your email'
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </FormControl>
          <FormControl>
            <FormLabel>Password</FormLabel>
            <Input
              type='password'
              placeholder='Enter your password'
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              isRequired
            />
          </FormControl>
          {captcha && (
            <FormControl>
              <FormLabel>Type the characters shown</FormLabel>
              <HStack spacing={3} align="center" mb={2}>
                {/* Rendered through an <img> data URI rather than injected into
                    the DOM: an SVG placed inline can carry a <script>, while one
                    loaded as an image cannot run anything. The server writes this
                    markup, but the login page is not the place to rely on that. */}
                <Image
                  src={`data:image/svg+xml;utf8,${encodeURIComponent(captcha.svg)}`}
                  alt="Characters to type"
                  height="60px"
                  borderWidth="1px"
                  borderRadius="md"
                />
                <Button size="sm" variant="ghost" onClick={loadCaptcha}>
                  New image
                </Button>
              </HStack>
              <Input
                placeholder='Characters from the image'
                value={captchaAnswer}
                onChange={(e) => setCaptchaAnswer(e.target.value)}
                autoComplete='off'
                isRequired
              />
              <Box mt={1}>
                <Text fontSize='xs' color='gray.600'>
                  Asked for after several failed attempts. Not case sensitive.
                </Text>
              </Box>
            </FormControl>
          )}
          <Text textAlign="center" color="blue.500" cursor="pointer" onClick={handleForgotPassword}>
        Forgot Password ?
      </Text>
          <Button
            isLoading={isLoading}
            type='submit'
            colorScheme='blackAlpha'
            bg={'blackAlpha.900 !important'}
            width={'100%'}>
            Login
          </Button>
        </VStack>
      </form>

      {message && <Text mt={4}>{message}</Text>}
    </Flex>
  )
}

export default LoginForm