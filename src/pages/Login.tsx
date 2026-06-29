import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function Login() {
  const { user, signIn, signUp } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string })?.from ?? '/mypage'

  const [mode, setMode]           = useState<'login' | 'signup'>('login')
  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [error, setError]         = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [signupDone, setSignupDone] = useState(false)

  useEffect(() => {
    if (user) navigate(from, { replace: true })
  }, [user, navigate, from])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    if (mode === 'login') {
      const err = await signIn(email, password)
      if (err) {
        setError(err.message)
      }
    } else {
      if (password.length < 6) {
        setError('비밀번호는 6자 이상이어야 합니다.')
        setSubmitting(false)
        return
      }
      const err = await signUp(email, password)
      if (err) {
        setError(err.message.includes('already') ? '이미 가입된 이메일입니다.' : err.message)
      } else {
        setSignupDone(true)
      }
    }
    setSubmitting(false)
  }

  if (signupDone) {
    return (
      <div style={styles.wrap}>
        <div style={styles.card}>
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>✅</div>
            <div style={{ color: '#e6edf3', fontSize: 16, fontWeight: 600, marginBottom: 8 }}>가입 완료!</div>
            <div style={{ color: '#8b949e', fontSize: 13, marginBottom: 20 }}>
              이메일 인증 후 로그인해 주세요.<br />
              (Supabase에서 이메일 인증을 비활성화한 경우 바로 로그인 가능합니다.)
            </div>
            <button style={styles.submitBtn} onClick={() => { setMode('login'); setSignupDone(false) }}>
              로그인하기
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <div style={styles.tabs}>
          <button
            style={{ ...styles.tab, ...(mode === 'login' ? styles.tabActive : {}) }}
            onClick={() => { setMode('login'); setError(null) }}
          >
            로그인
          </button>
          <button
            style={{ ...styles.tab, ...(mode === 'signup' ? styles.tabActive : {}) }}
            onClick={() => { setMode('signup'); setError(null) }}
          >
            회원가입
          </button>
        </div>

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>이메일</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              style={styles.input}
              placeholder="user@example.com"
              required
              autoComplete="email"
            />
          </div>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>비밀번호</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={styles.input}
              placeholder={mode === 'signup' ? '6자 이상' : ''}
              required
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </div>

          {error && <div style={styles.error}>{error}</div>}

          <button type="submit" disabled={submitting} style={styles.submitBtn}>
            {submitting ? '처리 중...' : mode === 'login' ? '로그인' : '가입하기'}
          </button>
        </form>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingTop: 60,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 12,
    padding: '32px 28px',
  },
  tabs: {
    display: 'flex',
    gap: 0,
    marginBottom: 28,
    borderBottom: '1px solid #30363d',
  },
  tab: {
    flex: 1,
    padding: '10px 0',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: '#6b7280',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'color 0.15s, border-color 0.15s',
  },
  tabActive: {
    color: '#e6edf3',
    borderBottomColor: '#1f6feb',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  label: {
    fontSize: 13,
    color: '#8b949e',
    fontWeight: 500,
  },
  input: {
    padding: '9px 12px',
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 6,
    color: '#e6edf3',
    fontSize: 14,
    outline: 'none',
  },
  error: {
    fontSize: 13,
    color: '#f85149',
    background: '#3d1111',
    border: '1px solid #5a1a1a',
    borderRadius: 6,
    padding: '8px 12px',
  },
  submitBtn: {
    padding: '10px 0',
    background: '#1f6feb',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 4,
  },
}
