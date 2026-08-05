import React from 'react'
import logoImage from '../../assets/logo.png'

import { Image, Text } from '@chakra-ui/react'
import { keyframes } from '@emotion/react'

// The gradient is twice the width of the text, so sliding it one full text-width
// reads as a sweep of light travelling across the word.
const shimmer = keyframes`
  from { background-position: 0% center; }
  to   { background-position: 200% center; }
`

const FormHeader = () => {
  return (
    <>
      <Image
        width={{
          base: '4rem',
          md: '5rem',
          lg: '6rem',
        }}
        height={{
          base: '4rem',
          md: '5rem',
          lg: '6rem',
        }}
        display={{
          base: 'none',
          md: 'block',
        }}
        marginInline={'auto'}
        src={logoImage}
        alt='NITJ Logo'
        mb={2}
        userSelect={'none'}
        draggable={false}
      />

      <Text
        fontSize={{
          base: '2xl',
          md: '3xl',
          lg: '4xl',
        }}
        textAlign={'center'}
        fontWeight='bold'
        mb={0}>
        Welcome to Xceed{' '}
        <Text
          as='span'
          bgGradient='linear(to-r, teal.400, blue.500, purple.500, blue.500, teal.400)'
          bgClip='text'
          backgroundSize='200% auto'
          animation={`${shimmer} 4s linear infinite`}
          sx={{
            '@media (prefers-reduced-motion: reduce)': {
              animation: 'none',
            },
          }}>
          Learning
        </Text>
      </Text>
      <Text
        fontSize='md'
        mb={{
          base: '1rem',
          md: '1.5rem',
        }}
        textAlign={'center'}
        color={'gray.500'}>
        Empowering learning through digital innovation
      </Text>
    </>
  )
}

export default FormHeader
