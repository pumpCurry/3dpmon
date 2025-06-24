import torch


def main():
    """GPU availability check."""
    avail = torch.cuda.is_available()
    print(f"GPU available: {avail}")

if __name__ == "__main__":
    main()
