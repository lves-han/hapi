import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import SettingsStoragePage from './storage'

const sqliteUsage = {
    backend: 'sqlite' as const,
    path: 'C:\\hapi\\hapi.db',
    databaseBytes: 1,
    walBytes: 2,
    shmBytes: 3,
    totalBytes: 6,
}
const getStorageUsage = vi.fn().mockResolvedValue(sqliteUsage)

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: { getStorageUsage } }),
}))

describe('SettingsStoragePage', () => {
    beforeEach(() => {
        getStorageUsage.mockReset().mockResolvedValue(sqliteUsage)
    })

    it('uses paired button theme colors and shows a single chart card without a duplicate exact-sizes table', async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <SettingsStoragePage />
                </I18nProvider>
            </QueryClientProvider>,
        )

        const refreshButton = screen.getByRole('button', { name: /refresh/i })
        expect(refreshButton).toHaveClass('bg-[var(--app-button)]')
        expect(refreshButton).toHaveClass('text-[var(--app-button-text)]')
        expect(refreshButton).not.toHaveClass('text-white')

        await waitFor(() => {
            expect(screen.getByRole('img', { name: /Relative share/i })).toBeInTheDocument()
        })

        expect(screen.queryByRole('heading', { name: /Exact sizes/i })).not.toBeInTheDocument()
        expect(screen.getByTestId('storage-pie-legend-database')).toBeInTheDocument()
        expect(screen.getByTestId('storage-pie-total')).toBeInTheDocument()
        expect(screen.getByTestId('storage-pie-path')).toHaveTextContent('C:\\hapi\\hapi.db')
    })

    it('shows PostgreSQL database usage and refreshes it', async () => {
        getStorageUsage.mockResolvedValue({ backend: 'postgres', databaseName: 'hapi', totalBytes: 1024 })
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <SettingsStoragePage />
                </I18nProvider>
            </QueryClientProvider>,
        )

        expect(await screen.findByText('PostgreSQL')).toBeInTheDocument()
        expect(screen.getByText('hapi')).toBeInTheDocument()
        expect(screen.getByText('1 KB')).toBeInTheDocument()
        expect(screen.queryByTestId('storage-pie-path')).not.toBeInTheDocument()
        expect(screen.queryByText(/Hub SQLite/)).not.toBeInTheDocument()

        getStorageUsage.mockResolvedValue({ backend: 'postgres', databaseName: 'hapi', totalBytes: 2048 })
        fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }))
        expect(await screen.findByText('2 KB')).toBeInTheDocument()
        expect(getStorageUsage).toHaveBeenCalledTimes(2)
    })
})
