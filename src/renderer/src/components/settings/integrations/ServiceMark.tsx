// The GitHub, Linear, Slack and sandbox services' marks on their brand tiles (lucide has no brand icons).
import type { IntegrationService } from '../../../../../shared/integrations'
import { GithubMark } from '../../GitlabMark'

const LINEAR_PATH =
  'M1.2 9.6l5.2 5.2A7 7 0 0 1 1.2 9.6zM1 7.5l7.5 7.5c.6 0 1.2-.1 1.8-.3L1.3 5.7c-.2.6-.3 1.2-.3 1.8zm.9-3.1l9.7 9.7c.5-.3.9-.6 1.3-1L2.9 3.1c-.4.4-.7.8-1 1.3zM4 2.2A7 7 0 0 1 13.8 12L4 2.2z'

function LinearGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">
      <path fill="currentColor" d={LINEAR_PATH} />
    </svg>
  )
}

function SlackGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">
      <g fill="currentColor">
        <rect x="6" y="1" width="2.6" height="6.2" rx="1.3" />
        <rect x="7.4" y="8.8" width="2.6" height="6.2" rx="1.3" />
        <rect x="1" y="7.4" width="6.2" height="2.6" rx="1.3" />
        <rect x="8.8" y="6" width="6.2" height="2.6" rx="1.3" />
      </g>
    </svg>
  )
}

// Vercel's mark: a triangle.
function VercelGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">
      <path fill="currentColor" d="M8 2l7 12H1z" />
    </svg>
  )
}

export const SERVICE_NAMES: Record<IntegrationService, string> = { github: 'GitHub', linear: 'Linear', slack: 'Slack', vercel: 'Vercel', docker: 'Docker', e2b: 'E2B', daytona: 'Daytona' }

// Docker: a stack of containers. E2B and Daytona: their initials (their marks aren't simple shapes).
function DockerGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">
      <g fill="currentColor">
        <rect x="2" y="7" width="3" height="3" rx="0.5" />
        <rect x="5.5" y="7" width="3" height="3" rx="0.5" />
        <rect x="9" y="7" width="3" height="3" rx="0.5" />
        <rect x="5.5" y="3.5" width="3" height="3" rx="0.5" />
        <path d="M1 11h13.5c-.6 2-2.6 3-5.5 3H5c-2 0-3.4-1.1-4-3z" />
      </g>
    </svg>
  )
}

function InitialsGlyph({ size, text }: { size: number; text: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">
      <text x="8" y="11.5" textAnchor="middle" fontSize={text.length > 2 ? 6.5 : 9} fontWeight="700" fontFamily="system-ui, sans-serif" fill="currentColor">
        {text}
      </text>
    </svg>
  )
}

function glyphFor(service: IntegrationService, glyph: number) {
  switch (service) {
    case 'github':
      return <GithubMark size={glyph} />
    case 'linear':
      return <LinearGlyph size={glyph} />
    case 'vercel':
      return <VercelGlyph size={glyph} />
    case 'docker':
      return <DockerGlyph size={glyph} />
    case 'e2b':
      return <InitialsGlyph size={glyph} text="E2B" />
    case 'daytona':
      return <InitialsGlyph size={glyph} text="D" />
    default:
      return <SlackGlyph size={glyph} />
  }
}

export function ServiceMark({ service, size = 18 }: { service: IntegrationService; size?: number }) {
  const glyph = Math.round(size * 0.64)
  return (
    <span className={`int-mark ${service}`} style={{ width: size, height: size }} aria-hidden>
      {glyphFor(service, glyph)}
    </span>
  )
}
