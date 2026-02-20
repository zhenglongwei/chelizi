import { useState, useEffect } from 'react';
import api from '../utils/api';

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const token = localStorage.getItem('admin_token');
    const userInfo = localStorage.getItem('admin_user');
    if (token && userInfo) {
      setIsAuthenticated(true);
      setUser(JSON.parse(userInfo));
    }
    setLoading(false);
  }, []);

  const login = async (username: string, password: string) => {
    try {
      const res = await api.post('/v1/admin/login', { username, password });
      const token = res?.data?.token ?? res?.token;
      const userData = res?.data?.user ?? res?.user ?? { username, role: 'admin' };
      if (token) {
        localStorage.setItem('admin_token', token);
        localStorage.setItem('admin_user', JSON.stringify(userData));
        setIsAuthenticated(true);
        setUser(userData);
        return { success: true };
      }
      return { success: false, message: res?.message || '登录失败' };
    } catch (err: any) {
      return { success: false, message: err?.response?.data?.message || err?.message || '登录失败' };
    }
  };

  const logout = () => {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    setIsAuthenticated(false);
    setUser(null);
  };

  return {
    isAuthenticated,
    loading,
    user,
    login,
    logout,
  };
}

