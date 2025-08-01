import * as Sentry from '@sentry/nextjs'
import { useIsLoggedIn, useUser } from 'common'
import { useRouter } from 'next/router'
import { PropsWithChildren, createContext, useContext, useMemo } from 'react'
import { toast } from 'sonner'

import { usePermissionsQuery } from 'data/permissions/permissions-query'
import { useProfileCreateMutation } from 'data/profile/profile-create-mutation'
import { useProfileQuery } from 'data/profile/profile-query'
import type { Profile } from 'data/profile/types'
import { useSendEventMutation } from 'data/telemetry/send-event-mutation'
import type { ResponseError } from 'types'
import { useSignOut } from './auth'
import { getGitHubProfileImgUrl } from './github'

export type ProfileContextType = {
  profile: Profile | undefined
  error: ResponseError | null
  isLoading: boolean
  isError: boolean
  isSuccess: boolean
}

export const ProfileContext = createContext<ProfileContextType>({
  profile: undefined,
  error: null,
  isLoading: true,
  isError: false,
  isSuccess: false,
})

export const ProfileProvider = ({ children }: PropsWithChildren<{}>) => {
  const user = useUser()
  const isLoggedIn = useIsLoggedIn()
  const router = useRouter()
  const signOut = useSignOut()

  const { mutate: sendEvent } = useSendEventMutation()
  const { mutate: createProfile, isLoading: isCreatingProfile } = useProfileCreateMutation({
    onSuccess: () => {
      sendEvent({ action: 'sign_up', properties: { category: 'conversion' } })

      if (user) {
        // Send an event to GTM, will do nothing if GTM is not enabled
        const thisWindow = window as any
        thisWindow.dataLayer = thisWindow.dataLayer || []
        thisWindow.dataLayer.push({
          event: 'sign_up',
          email: user.email,
        })
      }
    },
    onError: (error) => {
      if (error.code === 409) {
        // [Joshen] There's currently an assumption that createProfile is getting triggered
        // multiple times unnecessarily, although the tracing the code i can't see why this might
        // be happening unless GET profile is somehow returning `User's profile not found` incorrectly
        // Adding a Sentry capture + toast in hopes to catch this while developing on local / staging
        Sentry.captureMessage('Profile already exists: ' + error.message)
        if (process.env.NEXT_PUBLIC_ENVIRONMENT !== 'prod') {
          toast.error('[DEV] createProfile called despite profile already exists: ' + error.message)
        }
      } else {
        Sentry.captureMessage('Failed to create users profile: ' + error.message)
        toast.error('Failed to create your profile. Please refresh to try again.')
      }
    },
  })

  // Track telemetry for the current user
  const {
    error,
    data: profile,
    isLoading: isLoadingProfile,
    isError,
    isSuccess,
  } = useProfileQuery({
    enabled: isLoggedIn,
    onError(err) {
      // if the user does not yet exist, create a profile for them
      if (err.message === "User's profile not found") {
        createProfile()
      }

      // [Alaister] If the user has a bad auth token, auth-js won't know about it
      // and will think the user is authenticated. Since fetching the profile happens
      // on every page load, we can check for a 401 here and sign the user out if
      // they have a bad token.
      if (err.code === 401) {
        signOut().then(() => router.push('/sign-in'))
      }
    },
  })

  const { isInitialLoading: isLoadingPermissions } = usePermissionsQuery({ enabled: isLoggedIn })

  const value = useMemo(() => {
    const isLoading = isLoadingProfile || isCreatingProfile || isLoadingPermissions
    const isGHUser = !!profile && 'auth0_id' in profile && profile?.auth0_id.startsWith('github')
    const profileImageUrl = isGHUser ? getGitHubProfileImgUrl(profile.username) : undefined

    return {
      error,
      profile: !!profile ? { ...profile, profileImageUrl } : undefined,
      isLoading,
      isError,
      isSuccess,
    }
  }, [
    isLoadingProfile,
    isCreatingProfile,
    isLoadingPermissions,
    profile,
    error,
    isError,
    isSuccess,
  ])

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
}

export const useProfile = () => useContext(ProfileContext)
