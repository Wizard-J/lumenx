"use client";

import { useEffect } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { useSettingsStore } from '@/store/settingsStore';
import { getMessages } from '@/lib/i18n';
import { LightboxProvider } from '@/components/shared/preview/LightboxProvider';
import ToastContainer from '@/components/shared/ToastContainer';

export function Providers({ children }: { children: React.ReactNode }) {
    const locale = useSettingsStore((s) => s.locale);
    const theme = useSettingsStore((s) => s.theme);
    const messages = getMessages(locale);

    useEffect(() => {
        const html = document.documentElement;
        html.classList.remove('dark', 'light');
        html.classList.add(theme);
    }, [theme]);

    useEffect(() => {
        document.documentElement.lang = locale;
    }, [locale]);

    return (
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Shanghai">
            {/* LightboxProvider must wrap any subtree that uses PreviewImage /
             *  PreviewVideo. Singleton portal — see Issue 14 design notes in
             *  LightboxProvider.tsx. */}
            <LightboxProvider>
                {children}
                <ToastContainer />
            </LightboxProvider>
        </NextIntlClientProvider>
    );
}
