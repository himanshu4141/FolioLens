import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/src/store/appStore';

function PortfolioStoreConsumer({ onRender }: { onRender: () => void }) {
  useAppStore(useShallow((state) => ({
    defaultBenchmarkSymbol: state.defaultBenchmarkSymbol,
    setDefaultBenchmarkSymbol: state.setDefaultBenchmarkSymbol,
    portfolioChartWindow: state.portfolioChartWindow,
  })));
  onRender();
  return null;
}

function FundsStoreConsumer({ onRender }: { onRender: () => void }) {
  useAppStore(useShallow((state) => ({
    defaultBenchmarkSymbol: state.defaultBenchmarkSymbol,
    fundsSortBy: state.fundsSortBy,
    setFundsSortBy: state.setFundsSortBy,
    previewMode: state.previewMode,
  })));
  onRender();
  return null;
}

describe('appStore selector render isolation', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    useAppStore.setState({
      defaultBenchmarkSymbol: '^NSEITRI',
      portfolioChartWindow: '1Y',
      fundsSortBy: 'currentValue',
      previewMode: false,
      debugUnlocked: false,
      moneyTrailSortBy: 'newest',
    });
  });

  it('does not rerender Portfolio or Funds for unrelated global updates', () => {
    const portfolioRender = jest.fn();
    const fundsRender = jest.fn();
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(PortfolioStoreConsumer, { onRender: portfolioRender }),
          React.createElement(FundsStoreConsumer, { onRender: fundsRender }),
        ),
      );
    });
    expect(portfolioRender).toHaveBeenCalledTimes(1);
    expect(fundsRender).toHaveBeenCalledTimes(1);

    act(() => {
      useAppStore.setState({ debugUnlocked: true, moneyTrailSortBy: 'oldest' });
    });
    expect(portfolioRender).toHaveBeenCalledTimes(1);
    expect(fundsRender).toHaveBeenCalledTimes(1);

    act(() => {
      useAppStore.setState({ defaultBenchmarkSymbol: '^NSE500TRI' });
    });
    expect(portfolioRender).toHaveBeenCalledTimes(2);
    expect(fundsRender).toHaveBeenCalledTimes(2);

    act(() => renderer?.unmount());
  });
});
