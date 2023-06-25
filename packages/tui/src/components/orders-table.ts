import { GlobalState, Order } from "@arb-protocol/core";
import chalk from "chalk";
import cliTable from "cli-table3";
import { uiStore } from "../ui-store";

interface Column {
  accessor: keyof Order;
  header: string;
  width: number;
  align: "left" | "right";
  formatter?: <T>(value: T) => string | number;
}

export const OrdersTable = (state: GlobalState) => {
  const uiState = uiStore.getState();

  const columns: Column[] = [
    {
      accessor: "createdAt",
      header: "Timestamp",
      width: 15,
      align: "left",
    },
    {
      accessor: "inTokenSymbol",
      header: "In Token",
      width: 10,
      align: "left",
      formatter: (value) => {
        return uiState.enableIncognitoMode
          ? chalk.white.dim("###")
          : String(value);
      },
    },
    {
      accessor: "outTokenSymbol",
      header: "Out Token",
      width: 10,
      align: "left",
      formatter: (value) => {
        return uiState.enableIncognitoMode
          ? chalk.white.dim("###")
          : String(value);
      },
    },
    {
      accessor: "size",
      header: "Size",
      width: 20,
      align: "right",
    },
    {
      accessor: "price",
      header: "Price",
      width: 20,
      align: "right",
    },
  ];

  const table = new cliTable({
    head: [
      ...columns.map(({ header }, columnIndex) => {
        const isColumnActive = false;

        return isColumnActive
          ? chalk.white.inverse(header)
          : chalk.white(header);
      }),
    ],
    colAligns: columns.map(({ align }) => align),
    colWidths: columns.map(({ width }) => width),
  });

  // get last 5 trades
  const entries = Array.from(state.orders).filter(([_, order]) => {
    return !order.isExecuted;
  });

  const rows = entries.map(([_, order]) => {
    const row = columns.map(({ accessor, formatter }, columnIndex) => {
      let value = order[accessor];

      const isRowActive = false;
      const isColumnActive = false;
      const isCellActive = false;

      if (accessor === "createdAt") {
        value = new Date(Number(order[accessor]))
          .toLocaleString()
          .split(",")
          .join("\n")
          .replaceAll(" ", "");
      }

      // formatter
      if (formatter) {
        value = formatter(value);
      }

      const cell = {
        content: isCellActive
          ? chalk.inverse(value?.toString())
          : value?.toString(),
        style: {},
      };

      if (isCellActive) {
        cell.style = {
          border: ["magenta"],
        };
      }

      return cell;
    });

    return row;
  });

  table.push(...rows);

  const str = table.toString();

  return str;
};
