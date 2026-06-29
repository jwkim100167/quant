import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function NavUser() {
  const { user, signOut, loading } = useAuth()
  const navigate = useNavigate()

  if (loading) return null

  if (!user) {
    return (
      <div className="nav-user">
        <NavLink to="/login" className="nav-user-login">로그인</NavLink>
      </div>
    )
  }

  const handleSignOut = async () => {
    await signOut()
    navigate('/')
  }

  return (
    <div className="nav-user">
      <span className="nav-user-email">{user.email?.split('@')[0]}</span>
      <NavLink to="/mypage">마이페이지</NavLink>
      <button className="btn-logout" onClick={handleSignOut}>로그아웃</button>
    </div>
  )
}
