-- ============================================================
-- 퀀트 투자 앱 - 유저 테이블 & 인증 설정
-- Supabase 대시보드 > SQL Editor 에서 실행하세요
-- ============================================================

-- 1. user_profiles (Auth 유저와 1:1)
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  display_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. user_strategies (유저별 전략 설정)
CREATE TABLE IF NOT EXISTS public.user_strategies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL DEFAULT '내 전략',
  scenario       TEXT NOT NULL DEFAULT 'top1_composite'
                 CHECK (scenario IN ('top1_count','top1_delta','top1_rate','top1_composite')),
  rolling_weeks  INT  NOT NULL DEFAULT 13 CHECK (rolling_weeks IN (4, 8, 13, 26)),
  confirm_weeks  INT  NOT NULL DEFAULT 1  CHECK (confirm_weeks IN (1, 2, 3)),
  source_filter  TEXT NOT NULL DEFAULT 'report'
                 CHECK (source_filter IN ('all','report','community')),
  sim_from_date  DATE,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_strategies_user_id ON public.user_strategies(user_id);

-- 3. RLS 활성화
ALTER TABLE public.user_profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_strategies ENABLE ROW LEVEL SECURITY;

-- 4. RLS 정책 (본인 데이터만 접근)
DROP POLICY IF EXISTS "own profile"     ON public.user_profiles;
DROP POLICY IF EXISTS "own strategies"  ON public.user_strategies;

CREATE POLICY "own profile" ON public.user_profiles
  FOR ALL USING (auth.uid() = id);

CREATE POLICY "own strategies" ON public.user_strategies
  FOR ALL USING (auth.uid() = user_id);

-- 5. 회원가입 시 user_profiles 자동 생성 트리거
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 선택사항: 이메일 인증 비활성화 (개발 편의용)
-- Supabase 대시보드 > Authentication > Providers > Email 에서
-- "Confirm email" 옵션을 OFF 하면 됩니다.
-- ============================================================
